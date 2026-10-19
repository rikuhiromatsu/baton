// WebSocket（/api/ws）。ServerMessage を受けてクエリキャッシュに反映する（設計書 4.5）
import type { QueryClient } from "@tanstack/react-query";
import { API_PATHS, ServerMessageSchema, WS_PING, WS_PONG, unpackServerMessage, type ClientEvent, type ServerEvent } from "@baton/shared";
import { addArtifact, appendEvent, setRunner, upsertDecision, upsertInstruction, upsertTask } from "./cache.ts";
import { qk } from "./keys.ts";

/** WebSocket と同じ形の最小限（モックが同じ形を実装する） */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
};
export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
export const PING_INTERVAL_MS = 25_000;
export const MAX_BACKOFF_MS = 30_000;

/** 再接続の待ち時間: 1 → 2 → 4 … 最大 30 秒 */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt));
}

/** 1 つのイベントをキャッシュに反映する */
export function applyServerEvent(qc: QueryClient, ev: ServerEvent): void {
  switch (ev.t) {
    case "hello":
      setRunner(qc, ev.runner);
      // 切れていた間のイベントを取りこぼしているかもしれないので、表示中のクエリを全部取り直す
      void qc.invalidateQueries({ refetchType: "active", predicate: (q) => q.queryKey[0] !== "session" });
      break;
    case "instruction.upserted":
      upsertInstruction(qc, ev.instruction);
      break;
    case "task.upserted":
      upsertTask(qc, ev.task);
      break;
    case "decision.upserted":
      upsertDecision(qc, ev.decision);
      break;
    case "artifact.created":
      addArtifact(qc, ev.artifact);
      break;
    case "agent_event.appended":
      appendEvent(qc, ev.event);
      break;
    case "runner.status":
      setRunner(qc, ev.runner);
      break;
    case "usage.updated":
      qc.setQueryData(qk.usage, ev.usage);
      break;
  }
}

export function wsUrl(loc: Location = window.location): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}${API_PATHS.ws}`;
}

export type RealtimeOptions = {
  qc: QueryClient;
  url?: string;
  createSocket?: SocketFactory;
  onConnectionChange?: (connected: boolean) => void;
};

export class Realtime {
  private readonly qc: QueryClient;
  private readonly url: string;
  private readonly createSocket: SocketFactory;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subscribedId: string | null = null;
  private stopped = true;

  constructor(opts: RealtimeOptions) {
    this.qc = opts.qc;
    this.url = opts.url ?? wsUrl();
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.onConnectionChange = opts.onConnectionChange;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close(1000, "bye");
    }
  }

  /** 接続が切れていればすぐにつなぎ直す（オンライン復帰・画面復帰） */
  nudge(): void {
    if (this.stopped) return;
    if (!this.socket || this.socket.readyState > OPEN) {
      this.attempt = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
    }
  }

  /** 詳細シートを開いている間だけ、その指示のログを購読する（1 ソケット 1 指示） */
  subscribe(instructionId: string | null): void {
    this.subscribedId = instructionId;
    this.sendSubscription();
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  private send(ev: ClientEvent | string): void {
    if (this.socket?.readyState !== OPEN) return;
    this.socket.send(typeof ev === "string" ? ev : JSON.stringify(ev));
  }

  private sendSubscription(): void {
    this.send(this.subscribedId ? { t: "subscribe", instructionId: this.subscribedId } : { t: "unsubscribe" });
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.onConnectionChange?.(true);
      if (this.subscribedId) this.sendSubscription();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send(WS_PING), PING_INTERVAL_MS);
    };
    socket.onmessage = (msg) => this.handleMessage(msg.data);
    socket.onerror = () => {
      // close が続けて来るので、そちらで再接続する
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.onConnectionChange?.(false);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string" || data === WS_PONG) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    for (const ev of unpackServerMessage(parsed.data)) applyServerEvent(this.qc, ev);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }
}

let socketFactory: SocketFactory | undefined;
/** モックが差し替える */
export function setSocketFactory(f: SocketFactory | undefined): void {
  socketFactory = f;
}
export function getSocketFactory(): SocketFactory | undefined {
  return socketFactory;
}

let current: Realtime | null = null;
export function setRealtime(rt: Realtime | null): void {
  current = rt;
}
export function getRealtime(): Realtime | null {
  return current;
}
