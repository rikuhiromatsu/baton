// 発言の送信（楽観的・送信待ち・再送）、既読、中断・新しい話題、プロジェクト案の「立てる」
import type { QueryClient } from "@tanstack/react-query";
import {
  LIMITS,
  type AcceptProposalInput,
  type ListMessagesOutput,
  type ListThreadsOutput,
  type ProjectProposal,
  type ThreadMessage,
} from "@baton/shared";
import { postToServiceWorker } from "../lib/push.ts";
import { useOutbox, type OutboxItem, type OutboxState, type OutboxTarget } from "../state/outbox.ts";
import { toastId, useToasts } from "../state/toasts.ts";
import { api, isNetworkError } from "./client.ts";
import { findThread, patchThread, upsertMessage } from "./cache.ts";
import { qk } from "./keys.ts";

/** 画面に描く発言（送信待ちのものは local に状態） */
export type DisplayMessage = ThreadMessage & { local?: OutboxState };

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** 送信待ちの発言を、サーバーの発言の後ろに混ぜる（純粋関数。サーバーに届いた clientId は除く。F2） */
export function mergeOutbox(server: readonly ThreadMessage[], outbox: readonly OutboxItem[], threadId: string): { items: DisplayMessage[]; delivered: string[] } {
  const known = new Set(server.map((m) => m.clientId).filter((c): c is string => !!c));
  const delivered: string[] = [];
  const maxSeq = server.reduce((m, x) => Math.max(m, x.seq), 0);
  const extra: DisplayMessage[] = [];
  for (const o of outbox) {
    if (o.target.kind !== "thread" || o.target.threadId !== threadId) continue;
    if (known.has(o.clientId)) {
      delivered.push(o.clientId);
      continue;
    }
    extra.push(localMessage(o, threadId, maxSeq + 1 + extra.length));
  }
  return { items: extra.length ? [...server, ...extra] : [...server], delivered };
}

export function localMessage(o: OutboxItem, threadId: string, seq: number): DisplayMessage {
  return {
    id: o.clientId,
    threadId,
    seq,
    authorKind: "ceo",
    authorAgentId: null,
    authorName: null,
    kind: "chat",
    body: o.body,
    instructionId: o.instructionId ?? null,
    sessionId: null,
    ref: o.contextProjectId ? { contextProjectId: o.contextProjectId } : {},
    status: "complete",
    reaction: null,
    notify: false,
    clientId: o.clientId,
    createdAt: o.createdAt,
    updatedAt: 0,
    local: o.state,
  };
}

export type SendOptions = { contextProjectId?: string | null; instructionId?: string | null };

/** スレッドに発言する。空白だけ・長すぎは送らない。戻り値は clientId（送らなかったときは null） */
export function sendToThread(qc: QueryClient, threadId: string, body: string, opts: SendOptions = {}, now = Date.now(), clientId: string = crypto.randomUUID()): string | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > LIMITS.ceoMessageMaxChars) return null;
  const item: OutboxItem = {
    clientId,
    target: { kind: "thread", threadId },
    body: trimmed,
    ...(opts.contextProjectId ? { contextProjectId: opts.contextProjectId } : {}),
    ...(opts.instructionId ? { instructionId: opts.instructionId } : {}),
    createdAt: now,
    state: isOnline() ? "sending" : "waiting",
  };
  useOutbox.getState().put(item);
  if (isOnline()) void deliver(qc, clientId);
  return clientId;
}

/** メンバーへの追加の依頼（D-54） */
export function sendToSession(qc: QueryClient, sessionId: string, instructionId: string, body: string, now = Date.now(), clientId: string = crypto.randomUUID()): string | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > LIMITS.ceoMessageMaxChars) return null;
  const target: OutboxTarget = { kind: "session", sessionId, instructionId };
  useOutbox.getState().put({ clientId, target, body: trimmed, createdAt: now, state: isOnline() ? "sending" : "waiting" });
  if (isOnline()) void deliver(qc, clientId);
  return clientId;
}

/** 送信待ちの 1 件を送る（再送でも同じ clientId なので二重にならない） */
export async function deliver(qc: QueryClient, clientId: string): Promise<boolean> {
  const item = useOutbox.getState().items[clientId];
  if (!item) return false;
  useOutbox.getState().setState(clientId, "sending");
  try {
    if (item.target.kind === "thread") {
      const res = await api.postMessage(item.target.threadId, {
        clientId,
        body: item.body,
        ...(item.contextProjectId ? { contextProjectId: item.contextProjectId } : {}),
        ...(item.instructionId ? { instructionId: item.instructionId } : {}),
      });
      if (res?.message) upsertMessage(qc, res.message);
      else void qc.invalidateQueries({ queryKey: qk.messages(item.target.threadId) });
    } else {
      await api.postSessionMessage(item.target.sessionId, { clientId, body: item.body });
      void qc.invalidateQueries({ queryKey: qk.transcriptsOf(item.target.sessionId) });
    }
    useOutbox.getState().remove(clientId);
    return true;
  } catch (e) {
    if (isNetworkError(e) && !isOnline()) {
      useOutbox.getState().setState(clientId, "waiting");
    } else {
      useOutbox.getState().setState(clientId, "failed");
      useToasts.getState().show({ id: toastId(), kind: "sendFailed", clientId, createdAt: Date.now() });
    }
    return false;
  }
}

/** オンラインに戻ったとき・起動時に、送信待ちを全部送る */
export async function flushOutbox(qc: QueryClient): Promise<void> {
  const items = Object.values(useOutbox.getState().items).filter((i) => i.state !== "failed");
  for (const item of items) await deliver(qc, item.clientId);
}

// ───────────── 既読（4.8） ─────────────

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingRead = new Map<string, number>();

/** 一番下付近まで見えたら既読にする（1 秒にまとめる）。未読数はすぐ 0 にする */
export function markThreadRead(qc: QueryClient, threadId: string, seq: number, debounceMs: number = LIMITS.readDebounceMs): void {
  const t = findThread(qc, threadId);
  if (t && t.lastReadSeq >= seq && t.unread === 0) return;
  patchThread(qc, threadId, (cur) => ({ ...cur, unread: 0, lastReadSeq: Math.max(cur.lastReadSeq, seq) }));
  postToServiceWorker({ t: "read", threadIds: [threadId], unread: totalUnread(qc) });
  pendingRead.set(threadId, Math.max(pendingRead.get(threadId) ?? 0, seq));
  if (readTimers.has(threadId)) return;
  readTimers.set(
    threadId,
    setTimeout(() => {
      readTimers.delete(threadId);
      const s = pendingRead.get(threadId);
      pendingRead.delete(threadId);
      if (s !== undefined) void api.readThread(threadId, s).catch(() => {});
    }, debounceMs),
  );
}

export function totalUnread(qc: QueryClient): number {
  return qc.getQueryData<ListThreadsOutput>(qk.threads)?.items.reduce((n, t) => n + t.unread, 0) ?? 0;
}

// ───────────── スレッドの操作 ─────────────

export async function interruptThread(qc: QueryClient, threadId: string): Promise<void> {
  try {
    await api.interruptThread(threadId);
  } catch {
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
  }
  void qc.invalidateQueries({ queryKey: qk.threads });
}

export async function interruptSession(qc: QueryClient, sessionId: string, instructionId: string): Promise<void> {
  try {
    await api.interruptSession(sessionId);
  } catch {
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
  }
  void qc.invalidateQueries({ queryKey: qk.detail(instructionId) });
}

export async function resetThread(qc: QueryClient, threadId: string): Promise<void> {
  try {
    const res = await api.resetThread(threadId);
    if (res?.message) upsertMessage(qc, res.message);
  } catch {
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
  }
}

/** リーダーのスレッドを離れた（会話の区切り。4.6） */
export function leaveThread(threadId: string): void {
  void api.leaveThread(threadId).catch(() => {});
}

export async function acceptProposal(qc: QueryClient, proposal: ProjectProposal, workspace: AcceptProposalInput["workspace"]): Promise<boolean> {
  const before = qc.getQueryData<ProjectProposal>(qk.proposal(proposal.id)) ?? proposal;
  qc.setQueryData<ProjectProposal>(qk.proposal(proposal.id), { ...before, status: "accepted" });
  try {
    const res = await api.acceptProposal(proposal.id, workspace ? { workspace } : {});
    qc.setQueryData<ProjectProposal>(qk.proposal(proposal.id), res.proposal);
    void qc.invalidateQueries({ queryKey: qk.sidebar });
    void qc.invalidateQueries({ queryKey: qk.threads });
    void qc.invalidateQueries({ queryKey: qk.org });
    void qc.invalidateQueries({ queryKey: qk.projects });
    return true;
  } catch {
    qc.setQueryData<ProjectProposal>(qk.proposal(proposal.id), before);
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    return false;
  }
}

export async function declineProposal(qc: QueryClient, proposal: ProjectProposal): Promise<boolean> {
  const before = qc.getQueryData<ProjectProposal>(qk.proposal(proposal.id)) ?? proposal;
  qc.setQueryData<ProjectProposal>(qk.proposal(proposal.id), { ...before, status: "declined" });
  try {
    await api.declineProposal(proposal.id);
    return true;
  } catch {
    qc.setQueryData<ProjectProposal>(qk.proposal(proposal.id), before);
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    return false;
  }
}

/** スレッドの最後の seq（既読に使う。送信待ちは数えない） */
export function lastServerSeq(qc: QueryClient, threadId: string): number {
  const items = qc.getQueryData<ListMessagesOutput>(qk.messages(threadId))?.items ?? [];
  return items.reduce((m, x) => Math.max(m, x.seq), 0);
}
