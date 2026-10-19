// claude -p の子プロセス 1 つ（stream-json の入出力。DESIGN-v2 1.2・5.3・5.7）。
// - stdout は 1 行 1 JSON。生の行は <DATA>/logs/<日付>/<session>.jsonl に全文（8.4）、正規化（transcript.ts）して購読者へ
// - stdin へは user・control_request（initialize・interrupt）・control_response（承認の答え）を書く
// - 止め方: interrupt → result を待つ → 標準入力を閉じる → 時間切れなら SIGTERM（D-67）
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  controlRequest,
  encodeStdin,
  initialNormalizeState,
  normalizeStreamLine,
  permissionResponse,
  userInput,
  type NormalizeResult,
  type NormalizeState,
  type PermissionAnswer,
  type SessionResultInfo,
  type StdinMessage,
} from "@baton/shared";
import type { Logger } from "../log.ts";

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

export type ProcessOptions = { bin: string; args: string[]; cwd: string; env: Record<string, string>; sessionId: string; rawLogDir: string | null; log: Logger };

export type ProcessListener = (r: NormalizeResult, raw: string) => void;

export class ClaudeProcess {
  readonly sessionId: string;
  private child: ChildProcess | null = null;
  private state: NormalizeState;
  private readonly listeners = new Set<ProcessListener>();
  private resultWaiters: ((r: SessionResultInfo | null) => void)[] = [];
  private raw: WriteStream | null = null;
  private stderrTail = "";
  private exitInfo: ProcessExit | null = null;
  private exitWaiters: ((e: ProcessExit) => void)[] = [];
  /** ターン中（user を送ってから result まで） */
  busy = false;
  lastResult: SessionResultInfo | null = null;

  private readonly opts: ProcessOptions;

  constructor(
    opts: {
      bin: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      sessionId: string;
      rawLogDir: string | null;
      log: Logger;
    },
  ) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.state = initialNormalizeState(opts.cwd);
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }
  get stderr(): string {
    return this.stderrTail;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  on(fn: ProcessListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.opts.rawLogDir) {
      try {
        mkdirSync(this.opts.rawLogDir, { recursive: true });
        this.raw = createWriteStream(path.join(this.opts.rawLogDir, `${this.sessionId}.jsonl`), { flags: "a" });
      } catch {
        this.raw = null;
      }
    }
    const child = spawn(this.opts.bin, this.opts.args, { cwd: this.opts.cwd, env: this.opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.onLine(line));
    child.on("error", (err) => {
      this.stderrTail += `\n[spawn] ${err.message}`;
    });
    child.on("close", (code, signal) => {
      this.exitInfo = { code, signal };
      this.busy = false;
      this.raw?.end();
      for (const w of this.resultWaiters.splice(0)) w(null);
      for (const w of this.exitWaiters.splice(0)) w(this.exitInfo);
    });
    // 制御プロトコルの初期化（probe と同じ。承認を stdio で受けるため）
    this.write(controlRequest(`init-${randomUUID()}`, { subtype: "initialize" }));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    this.raw?.write(`${line}\n`);
    let r: NormalizeResult;
    try {
      r = normalizeStreamLine(line, this.state);
    } catch (err) {
      this.opts.log.warn("stream-json を読めません", { sessionId: this.sessionId, error: (err as Error).message });
      return;
    }
    this.state = r.state;
    if (r.session?.kind === "result") {
      this.lastResult = r.session;
      this.busy = false;
    }
    for (const l of this.listeners) {
      try {
        l(r, line);
      } catch (err) {
        this.opts.log.warn("stream の購読者で例外", { sessionId: this.sessionId, error: (err as Error).message });
      }
    }
    if (r.session?.kind === "result") for (const w of this.resultWaiters.splice(0)) w(r.session);
  }

  write(msg: StdinMessage): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || this.exited) return false;
    stdin.write(encodeStdin(msg));
    return true;
  }

  /** 1 通の入力（ターン中なら次の一手の前に読まれる） */
  send(text: string): boolean {
    const ok = this.write(userInput(text));
    if (ok) this.busy = true;
    return ok;
  }

  respond(requestId: string, answer: PermissionAnswer): boolean {
    return this.write(permissionResponse(requestId, answer));
  }

  interrupt(): boolean {
    return this.write(controlRequest(`int-${randomUUID()}`, { subtype: "interrupt" }));
  }

  /** 次の result（プロセスが終われば null） */
  waitResult(signal?: AbortSignal): Promise<SessionResultInfo | null> {
    if (this.exited) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.resultWaiters.indexOf(done);
        if (i >= 0) this.resultWaiters.splice(i, 1);
        reject(signal?.reason);
      };
      const done = (r: SessionResultInfo | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.resultWaiters.push(done);
    });
  }

  waitExit(timeoutMs?: number): Promise<ProcessExit | null> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (e: ProcessExit | null) => {
        if (timer) clearTimeout(timer);
        resolve(e);
      };
      this.exitWaiters.push(done);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const i = this.exitWaiters.indexOf(done);
          if (i >= 0) this.exitWaiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  closeStdin(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      // 閉じている
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.exited) return;
    try {
      this.child?.kill(signal);
    } catch {
      // 終わっている
    }
  }

  /**
   * 止める（D-67）。ターン中なら interrupt → result を graceMs 待つ → 標準入力を閉じる → closeMs で SIGTERM → さらに 2 秒で SIGKILL。
   */
  async stop(opts: { interrupt: boolean; resultWaitMs: number; closeWaitMs: number }): Promise<void> {
    if (this.exited) return;
    if (opts.interrupt && this.busy) {
      this.interrupt();
      await Promise.race([this.waitResult().catch(() => null), new Promise((r) => setTimeout(r, opts.resultWaitMs))]);
    }
    this.closeStdin();
    const e = await this.waitExit(opts.closeWaitMs);
    if (e) return;
    this.kill("SIGTERM");
    if (await this.waitExit(2000)) return;
    this.kill("SIGKILL");
    await this.waitExit(2000);
  }
}
