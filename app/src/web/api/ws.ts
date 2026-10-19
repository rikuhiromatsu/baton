// WebSocket（/api/ws）。ServerMessage を受けてクエリキャッシュに反映する（v1 4.5・DESIGN-v2 12.5）
import type { QueryClient } from "@tanstack/react-query";
import {
  API_PATHS,
  ServerMessageSchema,
  WS_PING,
  WS_PONG,
  unpackServerMessage,
  type ClientEvent,
  type ServerEvent,
  type ThreadMessage,
} from "@baton/shared";
import { useStreams } from "../state/streams.ts";
import { toastId, useToasts } from "../state/toasts.ts";
import { useUi } from "../state/ui.ts";
import {
  addArtifact,
  appendTranscript,
  findThread,
  setProjectCounts,
  setQuota,
  setRunner,
  upsertDecision,
  upsertInstruction,
  upsertMessage,
  upsertSession,
  upsertTask,
  upsertThread,
  upsertWorkspace,
} from "./cache.ts";
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

// 組織図・サイドパネルは、いろいろなイベントのあとにまとめて取り直す（1 回の取り直しに束ねる）
const debounced = new Map<string, ReturnType<typeof setTimeout>>();
function invalidateSoon(qc: QueryClient, key: readonly unknown[], ms = 300): void {
  const k = JSON.stringify(key);
  if (debounced.has(k)) return;
  debounced.set(
    k,
    setTimeout(() => {
      debounced.delete(k);
      void qc.invalidateQueries({ queryKey: key });
    }, ms),
  );
}

/** トーストを出した発言（同じ発言の upsert が何度来ても 1 回だけ） */
const toasted = new Set<string>();

/** 発言が完成したとき、いま見ていないスレッドで notify=1 ならトースト（4.8） */
function maybeToast(qc: QueryClient, m: ThreadMessage): void {
  if (!m.notify || m.status !== "complete" || toasted.has(m.id)) return;
  if (m.authorKind === "ceo" || m.authorKind === "system" || m.authorKind === "secretary") return;
  toasted.add(m.id);
  const visible = useUi.getState().visibleThreadId;
  const docVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
  if (visible === m.threadId && docVisible) return;
  const thread = findThread(qc, m.threadId);
  const to = thread?.kind === "leader" && thread.projectId ? `/p/${thread.projectId}/leader` : "/";
  useToasts.getState().show({
    id: toastId(),
    kind: "message",
    threadId: m.threadId,
    to,
    authorKind: m.authorKind,
    authorName: m.authorName,
    projectName: thread?.projectName ?? null,
    preview: m.body.replace(/\s+/g, " ").slice(0, 80),
    createdAt: Date.now(),
    duration: 4000,
  });
}

/** 起動直後に届く既存の発言でトーストを出さない（テストからも呼ぶ） */
export function markToasted(ids: readonly string[]): void {
  for (const id of ids) toasted.add(id);
}

/** 1 つのイベントをキャッシュに反映する */
export function applyServerEvent(qc: QueryClient, ev: ServerEvent): void {
  switch (ev.t) {
    case "hello":
      setRunner(qc, ev.runner);
      // 切れていた間のイベントを取りこぼしているかもしれないので、表示中のクエリを全部取り直す（streaming は本文から続ける）
      void qc.invalidateQueries({ refetchType: "active", predicate: (q) => q.queryKey[0] !== "session" });
      break;
    case "instruction.upserted":
      upsertInstruction(qc, ev.instruction);
      invalidateSoon(qc, qk.org);
      break;
    case "task.upserted":
      upsertTask(qc, ev.task);
      break;
    case "decision.upserted":
      upsertDecision(qc, ev.decision);
      invalidateSoon(qc, qk.sidebar);
      invalidateSoon(qc, qk.org);
      break;
    case "artifact.created":
      addArtifact(qc, ev.artifact);
      break;
    case "runner.status":
      setRunner(qc, ev.runner);
      qc.setQueryData(qk.org, (old: unknown) => (old && typeof old === "object" ? { ...(old as object), runner: ev.runner } : old));
      break;
    case "thread.updated":
      upsertThread(qc, ev.thread);
      invalidateSoon(qc, qk.org);
      break;
    case "message.upserted": {
      const m = ev.message;
      if (m.status === "streaming") useStreams.getState().begin(m.id, m.threadId, m.body);
      else useStreams.getState().end(m.id);
      upsertMessage(qc, m);
      // 本文が切られていたら、完成したものだけ取り直す（全文は REST）
      if (ev.bodyTruncated && m.status !== "streaming") void qc.invalidateQueries({ queryKey: qk.messages(m.threadId) });
      if (!qc.getQueryData(qk.messages(m.threadId))) {
        // まだ開いていないスレッド: 一覧の最後の発言だけ動かす
        invalidateSoon(qc, qk.threads, 500);
      }
      maybeToast(qc, m);
      if (m.kind === "project_proposal" && m.ref.proposalId) void qc.invalidateQueries({ queryKey: qk.proposal(m.ref.proposalId) });
      break;
    }
    case "message.delta": {
      const ok = useStreams.getState().delta(ev.messageId, ev.threadId, ev);
      if (!ok) {
        // 飛んでいた: REST の本文から取り直して続ける（4.7）
        void qc.invalidateQueries({ queryKey: qk.messages(ev.threadId) });
      }
      break;
    }
    case "project_proposal.upserted":
      qc.setQueryData(qk.proposal(ev.proposal.id), ev.proposal);
      break;
    case "session.upserted":
      upsertSession(qc, ev.session);
      invalidateSoon(qc, qk.org);
      break;
    case "transcript.appended":
      appendTranscript(qc, ev.items);
      break;
    case "session_input.upserted":
      if (ev.input.status === "delivered") void qc.invalidateQueries({ queryKey: qk.transcriptsOf(ev.input.sessionId) });
      break;
    case "workspace.upserted":
      upsertWorkspace(qc, ev.workspace);
      void qc.invalidateQueries({ queryKey: qk.diff(ev.workspace.instructionId) });
      break;
    case "project.upserted":
      invalidateSoon(qc, qk.sidebar);
      invalidateSoon(qc, qk.org);
      invalidateSoon(qc, qk.projects);
      invalidateSoon(qc, qk.threads);
      break;
    case "project.counts":
      setProjectCounts(qc, ev.projectId, ev.counts);
      break;
    case "quota.updated":
      setQuota(qc, ev.quota);
      qc.setQueryData(qk.org, (old: unknown) => (old && typeof old === "object" ? { ...(old as object), quota: ev.quota } : old));
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

export type Subscription = { threadId: string | null; instructionId: string | null };

export class Realtime {
  private readonly qc: QueryClient;
  private readonly url: string;
  private readonly createSocket: SocketFactory;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sub: Subscription = { threadId: null, instructionId: null };
  private visible = true;
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

  /** 開いているスレッド・指示（message.delta・transcript.appended の宛先） */
  subscribe(sub: Subscription): void {
    this.sub = sub;
    this.sendSubscription();
  }

  /** 画面が見えているか（見えている間は通知を送らない。D-88） */
  setPresence(visible: boolean): void {
    this.visible = visible;
    this.send({ t: "presence", visible });
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  private send(ev: ClientEvent | string): void {
    if (this.socket?.readyState !== OPEN) return;
    this.socket.send(typeof ev === "string" ? ev : JSON.stringify(ev));
  }

  private sendSubscription(): void {
    const { threadId, instructionId } = this.sub;
    if (!threadId && !instructionId) this.send({ t: "unsubscribe" });
    else this.send({ t: "subscribe", ...(threadId ? { threadId } : {}), ...(instructionId ? { instructionId } : {}) });
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
      this.sendSubscription();
      this.send({ t: "presence", visible: this.visible });
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
/** 開いているスレッド・指示（接続より先に画面が開いても、つながった時点で購読する） */
const desired: Subscription = { threadId: null, instructionId: null };
export function setRealtime(rt: Realtime | null): void {
  current = rt;
  rt?.subscribe({ ...desired });
}
export function subscribeThread(threadId: string | null): void {
  desired.threadId = threadId;
  current?.subscribe({ ...desired });
}
export function subscribeInstruction(instructionId: string | null): void {
  desired.instructionId = instructionId;
  current?.subscribe({ ...desired });
}
export function getRealtime(): Realtime | null {
  return current;
}
