// ログ。標準出力へ 1 行 1 件（launchd が ~/Library/Logs/baton/runner.log に書く）と、
// tailnet の生ログ（SSE）用に指示ごとのリングバッファを持つ。

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
};

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** トークンらしき値をログに出さない */
function redact(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = /token|authorization|secret/i.test(k) ? "[redacted]" : v;
  }
  return out;
}

export function createLogger(opts: { level?: LogLevel; write?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? ((process.env.BATON_LOG_LEVEL as LogLevel | undefined) ?? "info")] ?? ORDER.info;
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const rec = { t: new Date().toISOString(), level, msg, ...redact(data) };
    let line: string;
    try {
      line = JSON.stringify(rec);
    } catch {
      line = JSON.stringify({ t: rec.t, level, msg });
    }
    write(line);
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export type LiveLogEntry = { instructionId: string; at: number; kind: string; data: unknown };
type Listener = (e: LiveLogEntry) => void;

/**
 * 指示ごとのライブログ。D1 に送る前の生の内容（16KB で切らない）を持つ。
 * 直近 maxPerInstruction 件だけ残し、SSE の購読者に流す。
 */
export class LiveLog {
  private readonly buffers = new Map<string, LiveLogEntry[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly maxPerInstruction: number;
  private readonly maxInstructions: number;

  constructor(opts: { maxPerInstruction?: number; maxInstructions?: number } = {}) {
    this.maxPerInstruction = opts.maxPerInstruction ?? 1000;
    this.maxInstructions = opts.maxInstructions ?? 50;
  }

  append(instructionId: string, kind: string, data: unknown, at = Date.now()): void {
    const entry: LiveLogEntry = { instructionId, at, kind, data };
    let buf = this.buffers.get(instructionId);
    if (!buf) {
      buf = [];
      this.buffers.set(instructionId, buf);
      if (this.buffers.size > this.maxInstructions) {
        const oldest = this.buffers.keys().next().value;
        if (oldest !== undefined && oldest !== instructionId) this.buffers.delete(oldest);
      }
    }
    buf.push(entry);
    if (buf.length > this.maxPerInstruction) buf.splice(0, buf.length - this.maxPerInstruction);
    for (const l of this.listeners.get(instructionId) ?? []) {
      try {
        l(entry);
      } catch {
        // 購読者の失敗は無視
      }
    }
  }

  backlog(instructionId: string): LiveLogEntry[] {
    return [...(this.buffers.get(instructionId) ?? [])];
  }

  subscribe(instructionId: string, fn: Listener): () => void {
    let set = this.listeners.get(instructionId);
    if (!set) {
      set = new Set();
      this.listeners.set(instructionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(instructionId);
    };
  }
}
