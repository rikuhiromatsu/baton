// リアルタイム配信の Durable Object（設計書 4.5・D-6・D-7・D-30）。
// ブラウザとランナーの WebSocket を Hibernation API で持ち、イベントを配る。正本は D1。
import { DurableObject } from "cloudflare:workers";
import {
  ClientEventSchema,
  LIMITS,
  WS_PING,
  WS_PONG,
  type RunnerServerEvent,
  type RunnerStatus,
  type ServerEvent,
} from "@baton/shared";
import type { Env } from "../env.ts";
import { latestRunner, runnerStatusFromRow } from "../db/runners.ts";
import { allowedEmails } from "../middleware/auth.ts";

export const SOCKET_KIND_HEADER = "X-Baton-Socket";
export const SOCKET_RUNNER_HEADER = "X-Baton-Runner-Id";
/** ブラウザのソケットに紐づけるセッション（ログアウト・期限切れ・許可リストからの削除で切るため） */
export const SOCKET_SESSION_HEADER = "X-Baton-Session";
export const SOCKET_EMAIL_HEADER = "X-Baton-Email";
export const SOCKET_EXPIRES_HEADER = "X-Baton-Session-Expires";
/** 失効で閉じるときの close コード（画面は再接続して 401 → ログインへ） */
export const CLOSE_SESSION_REVOKED = 4401;

/** ソケットごとに保存する情報（休眠しても残る） */
export type SocketAttachment =
  | { kind: "browser"; sub: string | null; session: string; email: string; expiresAt: number }
  | { kind: "runner"; runnerId: string };

const BATCH_WINDOW_MS = 100;
const DISCONNECTED_AT_KEY = "runnerDisconnectedAt";

export class BatonHub extends DurableObject<Env> {
  private queue: ServerEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 生の "ping" には DO を起こさず "pong" を返す
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const kind = request.headers.get(SOCKET_KIND_HEADER);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (kind === "runner") {
      const runnerId = request.headers.get(SOCKET_RUNNER_HEADER) ?? "";
      this.ctx.acceptWebSocket(server, ["runner", `runner:${runnerId}`]);
      server.serializeAttachment({ kind: "runner", runnerId } satisfies SocketAttachment);
      server.send(JSON.stringify({ t: "hello", serverTime: Date.now() } satisfies RunnerServerEvent));
      await this.ctx.storage.delete(DISCONNECTED_AT_KEY);
      this.enqueue([{ t: "runner.status", runner: await this.runnerStatus() }]);
    } else if (kind === "browser") {
      const session = request.headers.get(SOCKET_SESSION_HEADER) ?? "";
      const email = (request.headers.get(SOCKET_EMAIL_HEADER) ?? "").toLowerCase();
      const expiresAt = Number(request.headers.get(SOCKET_EXPIRES_HEADER) ?? 0);
      if (!session || !email || !(expiresAt > Date.now())) return new Response("session required", { status: 401 });
      this.ctx.acceptWebSocket(server, ["browser", `session:${session}`]);
      server.serializeAttachment({ kind: "browser", sub: null, session, email, expiresAt } satisfies SocketAttachment);
      server.send(JSON.stringify({ t: "hello", serverTime: Date.now(), runner: await this.runnerStatus() } satisfies ServerEvent));
    } else {
      return new Response("unknown socket kind", { status: 400 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === WS_PING) {
      ws.send(WS_PONG);
      return;
    }
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || att.kind !== "browser") return; // ランナーからのメッセージは使わない
    if (!this.browserStillAllowed(att)) {
      closeRevoked(ws);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = ClientEventSchema.safeParse(data);
    if (!parsed.success) return;
    const sub = parsed.data.t === "subscribe" ? parsed.data.instructionId : null;
    ws.serializeAttachment({ ...att, sub } satisfies SocketAttachment);
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.onSocketGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // すでに閉じている
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (att?.kind !== "runner") return;
    const others = this.ctx.getWebSockets("runner").filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length > 0) return;
    // ランナーの WebSocket が閉じたら、ハートビートを待たずに offline を配る
    await this.ctx.storage.put(DISCONNECTED_AT_KEY, Date.now());
    const status = await this.runnerStatus();
    this.enqueue([{ t: "runner.status", runner: { ...status, online: false } }]);
  }

  /** 今のランナーの状態。WebSocket がつながっていれば online、切断後は次のハートビートまで offline */
  async runnerStatus(): Promise<RunnerStatus> {
    const now = Date.now();
    const row = await latestRunner(this.env.DB);
    const connected = this.ctx.getWebSockets("runner").some((s) => s.readyState === WebSocket.OPEN);
    if (connected) return runnerStatusFromRow(row, now, { online: true });
    const disconnectedAt = (await this.ctx.storage.get<number>(DISCONNECTED_AT_KEY)) ?? null;
    const base = runnerStatusFromRow(row, now);
    if (disconnectedAt !== null && (row?.last_heartbeat_at ?? 0) <= disconnectedAt) return { ...base, online: false };
    return base;
  }

  // ───────────── Worker から呼ぶ RPC ─────────────

  /** ブラウザへ配る。100ms 以内のものは束ねる */
  async publish(events: ServerEvent[]): Promise<void> {
    this.enqueue(events);
  }

  /** ランナーの状態を計算して配る（ハートビートで変化があったとき） */
  async publishRunnerStatus(): Promise<void> {
    this.enqueue([{ t: "runner.status", runner: await this.runnerStatus() }]);
  }

  /** ランナーへ合図を送る（束ねない）。runnerId を指定するとそのランナーだけ */
  async notifyRunners(events: RunnerServerEvent[], runnerId?: string): Promise<void> {
    const sockets = this.ctx.getWebSockets(runnerId ? `runner:${runnerId}` : "runner");
    for (const ws of sockets) {
      for (const ev of events) safeSend(ws, JSON.stringify(ev));
    }
  }

  /** ログアウトしたセッションのソケットを閉じる */
  async revokeSession(sessionHash: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`session:${sessionHash}`)) closeRevoked(ws);
  }

  /** 期限切れ・許可リストから外れたブラウザには配らない（HTTP 側の失効をリアルタイムにも効かせる） */
  private browserStillAllowed(att: Extract<SocketAttachment, { kind: "browser" }>): boolean {
    return att.expiresAt > Date.now() && allowedEmails(this.env).has(att.email);
  }

  /** テスト・診断用: 接続数 */
  async counts(): Promise<{ browser: number; runner: number }> {
    return { browser: this.ctx.getWebSockets("browser").length, runner: this.ctx.getWebSockets("runner").length };
  }

  private enqueue(events: ServerEvent[]): void {
    if (events.length === 0) return;
    this.queue.push(...events);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), BATCH_WINDOW_MS);
    }
  }

  private flush(): void {
    this.flushTimer = null;
    const events = this.queue;
    this.queue = [];
    if (events.length === 0) return;
    for (const ws of this.ctx.getWebSockets("browser")) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.kind !== "browser" || !this.browserStillAllowed(att)) {
        closeRevoked(ws);
        continue;
      }
      const sub = att.sub;
      const mine = events.filter((ev) => ev.t !== "agent_event.appended" || ev.event.instructionId === sub);
      if (mine.length === 0) continue;
      const payload = mine.length === 1 ? mine[0] : { t: "batch", items: mine };
      safeSend(ws, JSON.stringify(payload));
    }
  }
}

function closeRevoked(ws: WebSocket): void {
  try {
    ws.close(CLOSE_SESSION_REVOKED, "session revoked");
  } catch {
    // すでに閉じている
  }
}

function safeSend(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // 閉じかけのソケットは無視（次の接続で hello から取り直す）
  }
}

/** agent_event.appended で配る content を 2KB（文字数）に切る */
export function clipEventContent(content: unknown): unknown {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
  if (text.length <= LIMITS.eventBroadcastMaxChars) return content;
  return { truncated: true, text: text.slice(0, LIMITS.eventBroadcastMaxChars) };
}
