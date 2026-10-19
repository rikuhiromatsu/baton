// Hub（/api/runner/ws）への接続（設計書 4.5、D-3）。
// WebSocket は「仕事があるよ」の合図だけ。切れていても 15 秒ごとの claim で拾えるので、再接続は 1→2→4…最大 30 秒で気長に続ける。
// 認証は Authorization: Bearer ヘッダ（Node 26 の WebSocket は第 2 引数の { headers } でヘッダを付けられる）。
import { API_PATHS, RunnerServerEventSchema, type RunnerServerEvent } from "@baton/shared";
import type { Logger } from "./log.ts";

/** 使う部分だけの WebSocket の形（テストで差し替える） */
export type WsLike = {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

export const nodeWsFactory: WsFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as WsLike;

export function runnerWsUrl(batonUrl: string): string {
  const u = new URL(API_PATHS.runnerWs, batonUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** 再接続の待ち時間（1→2→4…最大 30 秒） */
export function backoffMs(attempt: number, maxMs = 30_000): number {
  return Math.min(maxMs, 1000 * 2 ** Math.max(0, attempt));
}

/** 届いた 1 メッセージを RunnerServerEvent の配列にする（Hub が { t: "batch", items } で束ねることがある） */
export function parseRunnerMessage(data: unknown): RunnerServerEvent[] {
  if (typeof data !== "string") return [];
  if (data === "pong") return [];
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return [];
  }
  const items = obj && typeof obj === "object" && (obj as { t?: unknown }).t === "batch" ? ((obj as { items?: unknown }).items ?? []) : [obj];
  if (!Array.isArray(items)) return [];
  const out: RunnerServerEvent[] = [];
  for (const it of items) {
    const r = RunnerServerEventSchema.safeParse(it);
    if (r.success) out.push(r.data);
  }
  return out;
}

export class RunnerSocket {
  private readonly url: string;
  private readonly token: string;
  private readonly factory: WsFactory;
  private readonly log: Logger;
  private readonly onEvent: (e: RunnerServerEvent) => void;
  private readonly pingIntervalMs: number;
  private ws: WsLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  connected = false;

  constructor(opts: { batonUrl: string; token: string; log: Logger; onEvent: (e: RunnerServerEvent) => void; factory?: WsFactory; pingIntervalMs?: number }) {
    this.url = runnerWsUrl(opts.batonUrl);
    this.token = opts.token;
    this.factory = opts.factory ?? nodeWsFactory;
    this.log = opts.log;
    this.onEvent = opts.onEvent;
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WsLike;
    try {
      ws = this.factory(this.url, { authorization: `Bearer ${this.token}` });
    } catch (err) {
      this.log.warn("WebSocket を開けません", { error: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      this.log.info("Hub に接続しました");
      this.pingTimer = setInterval(() => {
        try {
          if (ws.readyState === 1) ws.send("ping");
        } catch {
          // 次の close で再接続する
        }
      }, this.pingIntervalMs);
      // 接続し直した直後は取りこぼしがあり得るので、claim を促す
      this.onEvent({ t: "work.available" });
    };
    ws.onmessage = (ev) => {
      for (const e of parseRunnerMessage(ev.data)) this.onEvent(e);
    };
    ws.onerror = () => {
      // close が続いて来るので、そちらで再接続する
    };
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      const was = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (this.closed) return;
      if (was) this.log.warn("Hub との接続が切れました", { code: ev?.code, reason: ev?.reason });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const wait = backoffMs(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    this.reconnectTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.ws?.close(1000, "shutdown");
    } catch {
      // 既に閉じている
    }
    this.ws = null;
    this.connected = false;
  }
}
