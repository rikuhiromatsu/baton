// リアルタイム配信の Durable Object（v1 設計書 4.5・D-6・D-7・D-30・D-35、DESIGN-v2 10.2・11.6・12.5）。
// ブラウザとランナーの WebSocket を Hibernation API で持ち、イベントを配る。正本は D1。
// v2 で足したもの: 開いているスレッド・指示の購読（message.delta・transcript.appended の宛先）、
// 画面が見えているか（presence）と通知のまとめ（アラーム）、session.upserted の間引き、秘書 bot のレート制限、
// ランナーへの中断の依頼（ハートビートの応答でも返す）。
import { DurableObject } from "cloudflare:workers";
import { ClientEventSchema, LIMITS, WS_PING, WS_PONG, type RunnerServerEvent, type RunnerStatus, type ServerEvent } from "@baton/shared";
import { pushBatchMs, type Env } from "../env.ts";
import { latestRunner, runnerStatusFromRow } from "../db/runners.ts";
import { allowedEmails } from "../middleware/auth.ts";
import { composePushPayload, deliverPushToUser, type PushCandidate } from "../push/send.ts";

export const SOCKET_KIND_HEADER = "X-Baton-Socket";
export const SOCKET_RUNNER_HEADER = "X-Baton-Runner-Id";
/** ブラウザのソケットに紐づけるセッション（ログアウト・期限切れ・許可リストからの削除で切るため。D-35） */
export const SOCKET_SESSION_HEADER = "X-Baton-Session";
export const SOCKET_EMAIL_HEADER = "X-Baton-Email";
export const SOCKET_EXPIRES_HEADER = "X-Baton-Session-Expires";
/** 失効で閉じるときの close コード（画面は再接続して 401 → ログインへ） */
export const CLOSE_SESSION_REVOKED = 4401;

/** ソケットごとに保存する情報（休眠しても残る） */
export type BrowserAttachment = {
  kind: "browser";
  session: string;
  email: string;
  expiresAt: number;
  /** 開いているスレッド（message.delta の宛先） */
  threadId: string | null;
  /** 開いている指示（transcript.appended の宛先） */
  instructionId: string | null;
  /** 画面が見えているか（見えている間は通知を送らない。D-88）。接続直後は見えているとみなす */
  visible: boolean;
};
export type SocketAttachment = BrowserAttachment | { kind: "runner"; runnerId: string };

const BATCH_WINDOW_MS = 100;
const SESSION_EVENT_INTERVAL_MS = 1_000;
const DISCONNECTED_AT_KEY = "runnerDisconnectedAt";
const PUSH_PENDING_KEY = "pushPending";
const INTERRUPTS_KEY = "interrupts";
const INTERRUPT_TTL_MS = 5 * 60 * 1000;

/** 中断の依頼（id → 依頼の時刻と ID。古い形は時刻だけ） */
type InterruptEntry = number | { at: number; requestId: string };
type Interrupts = { threads: Record<string, InterruptEntry>; sessions: Record<string, InterruptEntry> };
export type InterruptRequest = { kind: "thread" | "session"; id: string; requestId: string };

export class BatonHub extends DurableObject<Env> {
  private queue: ServerEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** session.upserted の間引き（1 秒に 1 回まで） */
  private sessionSentAt = new Map<string, number>();
  private sessionPending = new Map<string, Extract<ServerEvent, { t: "session.upserted" }>>();
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 秘書 bot の呼び出し（トークンごとの直近 1 分の時刻） */
  private botCalls = new Map<string, number[]>();

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
      server.serializeAttachment({
        kind: "browser",
        session,
        email,
        expiresAt,
        threadId: null,
        instructionId: null,
        visible: true,
      } satisfies SocketAttachment);
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
    const ev = parsed.data;
    let next: BrowserAttachment = att;
    if (ev.t === "subscribe") next = { ...att, threadId: ev.threadId ?? null, instructionId: ev.instructionId ?? null };
    else if (ev.t === "unsubscribe") next = { ...att, threadId: null, instructionId: null };
    else if (ev.t === "presence") next = { ...att, visible: ev.visible };
    ws.serializeAttachment(next satisfies SocketAttachment);
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

  // ───────────── Worker から呼ぶ RPC: 配信 ─────────────

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

  /** テスト・診断用: 接続数 */
  async counts(): Promise<{ browser: number; runner: number }> {
    return { browser: this.ctx.getWebSockets("browser").length, runner: this.ctx.getWebSockets("runner").length };
  }

  // ───────────── 中断の依頼（ハートビートの応答で返す。12.3） ─────────────

  async addInterrupt(kind: "thread" | "session", id: string): Promise<string> {
    const cur = (await this.ctx.storage.get<Interrupts>(INTERRUPTS_KEY)) ?? { threads: {}, sessions: {} };
    const requestId = crypto.randomUUID();
    (kind === "thread" ? cur.threads : cur.sessions)[id] = { at: Date.now(), requestId };
    await this.ctx.storage.put(INTERRUPTS_KEY, cur);
    return requestId;
  }

  async takeInterrupts(): Promise<{ threadIds: string[]; sessionIds: string[]; requests: InterruptRequest[] }> {
    const cur = (await this.ctx.storage.get<Interrupts>(INTERRUPTS_KEY)) ?? { threads: {}, sessions: {} };
    await this.ctx.storage.delete(INTERRUPTS_KEY);
    const requests: InterruptRequest[] = [];
    const fresh = (kind: InterruptRequest["kind"], m: Record<string, InterruptEntry>) =>
      Object.entries(m)
        .filter(([id, e]) => {
          const at = typeof e === "number" ? e : e.at;
          if (Date.now() - at > INTERRUPT_TTL_MS) return false;
          requests.push({ kind, id, requestId: typeof e === "number" ? `legacy-${at}` : e.requestId });
          return true;
        })
        .map(([id]) => id);
    const threadIds = fresh("thread", cur.threads);
    const sessionIds = fresh("session", cur.sessions);
    return { threadIds, sessionIds, requests };
  }

  // ───────────── 秘書 bot のレート制限（11.6。トークンごとに 60 回／分、メモリで数える） ─────────────

  async botHit(tokenId: string, now = Date.now()): Promise<{ ok: boolean; retryAfterSec: number }> {
    const recent = (this.botCalls.get(tokenId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LIMITS.botCallsPerMinute) {
      this.botCalls.set(tokenId, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000)) };
    }
    recent.push(now);
    this.botCalls.set(tokenId, recent);
    return { ok: true, retryAfterSec: 0 };
  }

  // ───────────── 通知（10.2・D-88） ─────────────

  /** その利用者の見えているソケットが 1 つでもあるか */
  isVisible(email: string): boolean {
    const target = email.toLowerCase();
    return this.ctx.getWebSockets("browser").some((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      return att?.kind === "browser" && att.email === target && att.visible && this.browserStillAllowed(att);
    });
  }

  /**
   * 通知の候補。画面を開いている利用者には送らない。承認・判断（urgent）はすぐ送り、
   * それ以外は利用者ごとに pushBatchMs ためてアラームでまとめて送る。
   */
  async pushCandidate(candidate: PushCandidate): Promise<void> {
    const users = await this.pushTargets();
    if (users.length === 0) return;
    const pending = (await this.ctx.storage.get<Record<string, PushCandidate[]>>(PUSH_PENDING_KEY)) ?? {};
    let stored = false;
    for (const u of users) {
      if (this.isVisible(u.email)) continue;
      if (candidate.urgent) {
        const payload = await composePushPayload(this.env.DB, u.id, [candidate]);
        if (payload) await deliverPushToUser(this.env, u.id, payload, { urgent: true });
        continue;
      }
      (pending[u.id] ??= []).push(candidate);
      stored = true;
    }
    if (!stored) return;
    await this.ctx.storage.put(PUSH_PENDING_KEY, pending);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + pushBatchMs(this.env, LIMITS.pushBatchMs));
    }
  }

  override async alarm(): Promise<void> {
    await this.flushPush();
  }

  /** ためた候補を送る（アラーム。テストからも呼ぶ） */
  async flushPush(): Promise<number> {
    const pending = (await this.ctx.storage.get<Record<string, PushCandidate[]>>(PUSH_PENDING_KEY)) ?? {};
    await this.ctx.storage.delete(PUSH_PENDING_KEY);
    const users = new Map((await this.pushTargets()).map((u) => [u.id, u.email]));
    let sent = 0;
    for (const [userId, candidates] of Object.entries(pending)) {
      const email = users.get(userId);
      if (!email || this.isVisible(email)) continue;
      // 送る直前に既読を見直す（composePushPayload が既読のものを落とす）
      const payload = await composePushPayload(this.env.DB, userId, candidates);
      if (!payload) continue;
      await deliverPushToUser(this.env, userId, payload, { urgent: false });
      sent++;
    }
    return sent;
  }

  /** 購読を持っていて、許可リストにいる利用者 */
  private async pushTargets(): Promise<{ id: string; email: string }[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT DISTINCT u.id, u.email FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.enabled = 1",
    ).all<{ id: string; email: string }>();
    const allowed = allowedEmails(this.env);
    return results.filter((u) => allowed.has(u.email.toLowerCase()));
  }

  // ───────────── 内部 ─────────────

  /** 期限切れ・許可リストから外れたブラウザには配らない（HTTP 側の失効をリアルタイムにも効かせる。D-35） */
  private browserStillAllowed(att: BrowserAttachment): boolean {
    return att.expiresAt > Date.now() && allowedEmails(this.env).has(att.email);
  }

  private enqueue(events: ServerEvent[]): void {
    const now = Date.now();
    const pass: ServerEvent[] = [];
    for (const ev of events) {
      if (ev.t !== "session.upserted") {
        pass.push(ev);
        continue;
      }
      const id = ev.session.id;
      const last = this.sessionSentAt.get(id) ?? 0;
      if (now - last >= SESSION_EVENT_INTERVAL_MS && !this.sessionPending.has(id)) {
        this.sessionSentAt.set(id, now);
        pass.push(ev);
      } else {
        this.sessionPending.set(id, ev);
        this.scheduleSessionFlush(last + SESSION_EVENT_INTERVAL_MS - now);
      }
    }
    if (pass.length === 0) return;
    this.queue.push(...pass);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), BATCH_WINDOW_MS);
    }
  }

  private scheduleSessionFlush(delay: number): void {
    if (this.sessionTimer !== null) return;
    this.sessionTimer = setTimeout(
      () => {
        this.sessionTimer = null;
        const items = [...this.sessionPending.values()];
        this.sessionPending.clear();
        const now = Date.now();
        for (const ev of items) this.sessionSentAt.set(ev.session.id, now);
        if (items.length > 0) {
          this.queue.push(...items);
          if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flush(), BATCH_WINDOW_MS);
        }
      },
      Math.max(0, delay),
    );
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
      const mine: ServerEvent[] = [];
      for (const ev of events) {
        const routed = routeForSocket(ev, att);
        if (routed) mine.push(routed);
      }
      if (mine.length === 0) continue;
      const payload = mine.length === 1 ? mine[0] : { t: "batch", items: mine };
      safeSend(ws, JSON.stringify(payload));
    }
  }
}

/** そのソケットに届けるか（宛先の絞り込み。12.5） */
function routeForSocket(ev: ServerEvent, att: BrowserAttachment): ServerEvent | null {
  if (ev.t === "message.delta") return att.threadId === ev.threadId ? ev : null;
  if (ev.t === "transcript.appended") {
    const items = ev.items.filter(
      (it) => (it.instructionId !== null && it.instructionId === att.instructionId) || (it.threadId !== null && it.threadId === att.threadId),
    );
    return items.length > 0 ? { t: "transcript.appended", items } : null;
  }
  return ev;
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
