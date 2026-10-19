// 状態を変える操作（楽観的更新・巻き戻し・取り消し）。画面から切り離して F1・F2 で検査する
import type { QueryClient } from "@tanstack/react-query";
import {
  LIMITS,
  NO_UNDO_ACTIONS,
  nextStatus,
  type AnswerDecisionInput,
  type CeoAction,
  type InstructionSummary,
  type ListInstructionsOutput,
} from "@baton/shared";
import { useOutbox } from "../state/outbox.ts";
import { toastId, useToasts } from "../state/toasts.ts";
import { useUi } from "../state/ui.ts";
import { api, isConflict, isNetworkError, listAllInstructions } from "./client.ts";
import { findInstruction, removeInstruction, upsertDecision, upsertInstruction } from "./cache.ts";
import { qk } from "./keys.ts";

// ───────────── 指示の送信 ─────────────

export function makeOptimistic(clientId: string, body: string, now: number): InstructionSummary {
  return {
    id: clientId,
    clientId,
    body,
    title: null,
    status: "queued",
    statusChangedAt: now,
    projectId: null,
    projectName: null,
    resultSummary: null,
    openDecisionId: null,
    notBefore: null,
    error: null,
    taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
    createdAt: now,
    // サーバーの応答・イベントが必ず勝つよう 0 にしておく
    updatedAt: 0,
    completedAt: null,
  };
}

/** まだ送れていない指示（楽観的な行）を一覧に混ぜる */
export function mergeOutbox(list: ListInstructionsOutput): ListInstructionsOutput {
  const pending = Object.values(useOutbox.getState().items);
  if (pending.length === 0) return list;
  const known = new Set(list.items.map((i) => i.clientId));
  const extra = pending.filter((p) => !known.has(p.clientId)).map((p) => makeOptimistic(p.clientId, p.body, p.createdAt));
  // サーバーに届いていた分は送信待ちから外す
  for (const p of pending) if (known.has(p.clientId)) useOutbox.getState().remove(p.clientId);
  return extra.length ? { ...list, items: [...extra, ...list.items] } : list;
}

export async function fetchActiveList(signal?: AbortSignal): Promise<ListInstructionsOutput> {
  return mergeOutbox(await listAllInstructions("active", signal));
}

function insertOptimistic(qc: QueryClient, item: InstructionSummary): void {
  qc.setQueryData<ListInstructionsOutput>(qk.list("active"), (old) => {
    if (!old) return old;
    return { ...old, items: [item, ...old.items.filter((i) => i.clientId !== item.clientId)] };
  });
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** 指示を送る。空白だけなら送らない。戻り値は clientId（送らなかったときは null） */
export function submitInstruction(qc: QueryClient, body: string, now = Date.now(), clientId: string = crypto.randomUUID()): string | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 8000) return null;
  insertOptimistic(qc, makeOptimistic(clientId, trimmed, now));
  useOutbox.getState().put({ clientId, body: trimmed, createdAt: now, state: isOnline() ? "sending" : "waiting" });
  if (isOnline()) void deliver(qc, clientId);
  return clientId;
}

/** 送信待ちの 1 件を送る（再送でも同じ clientId なので二重にならない） */
export async function deliver(qc: QueryClient, clientId: string): Promise<boolean> {
  const item = useOutbox.getState().items[clientId];
  if (!item) return false;
  useOutbox.getState().setState(clientId, "sending");
  // 一覧に無ければ（再起動後など）戻す
  if (!findInstruction(qc, clientId) && !qc.getQueryData<ListInstructionsOutput>(qk.list("active"))?.items.some((i) => i.clientId === clientId)) {
    insertOptimistic(qc, makeOptimistic(clientId, item.body, item.createdAt));
  }
  try {
    const created = await api.createInstruction({ clientId, body: item.body });
    useOutbox.getState().remove(clientId);
    upsertInstruction(qc, created, { force: true });
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

// ───────────── フリックの遷移 ─────────────

export type TransitionResult = { ok: true; instruction: InstructionSummary } | { ok: false; conflict: boolean };

export async function performTransition(
  qc: QueryClient,
  inst: InstructionSummary,
  action: CeoAction,
  comment?: string,
): Promise<TransitionResult> {
  const before = findInstruction(qc, inst.id) ?? inst;
  const to = action === "restore" ? null : nextStatus(before.status, action);
  // 楽観的に動かす（updatedAt は動かさない＝サーバーのイベントが必ず勝つ）
  if (to) upsertInstruction(qc, { ...before, status: to, statusChangedAt: Date.now() }, { force: true });
  else if (action === "restore") removeInstruction(qc, before.id);
  try {
    const res = await api.transition(before.id, { action, expectedStatus: before.status, comment });
    upsertInstruction(qc, res.instruction, { force: true });
    if (!NO_UNDO_ACTIONS.includes(action)) {
      useToasts.getState().show({
        id: toastId(),
        kind: "undo",
        action,
        instructionId: before.id,
        transitionId: res.transitionId,
        createdAt: Date.now(),
        duration: LIMITS.undoToastMs,
      });
    }
    return { ok: true, instruction: res.instruction };
  } catch (e) {
    // 巻き戻して、カードを揺らす
    upsertInstruction(qc, before, { force: true });
    useUi.getState().shake(before.clientId);
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    const conflict = isConflict(e);
    if (conflict) {
      void qc.invalidateQueries({ queryKey: qk.lists });
      void qc.invalidateQueries({ queryKey: qk.detail(before.id) });
    }
    return { ok: false, conflict };
  }
}

export async function performUndo(qc: QueryClient, transitionId: string): Promise<boolean> {
  try {
    const res = await api.undo(transitionId);
    upsertInstruction(qc, res.instruction, { force: true });
    return true;
  } catch {
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    void qc.invalidateQueries({ queryKey: qk.lists });
    return false;
  }
}

export async function answerDecision(qc: QueryClient, instructionId: string, decisionId: string, input: AnswerDecisionInput): Promise<boolean> {
  try {
    const res = await api.answerDecision(decisionId, input);
    upsertDecision(qc, res.decision);
    upsertInstruction(qc, res.instruction, { force: true });
    return true;
  } catch (e) {
    useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    if (isConflict(e)) {
      void qc.invalidateQueries({ queryKey: qk.detail(instructionId) });
      void qc.invalidateQueries({ queryKey: qk.lists });
    }
    return false;
  }
}
