// 指示の状態を変える操作（楽観的更新・巻き戻し・取り消し）と承認・判断の回答
import type { QueryClient } from "@tanstack/react-query";
import { LIMITS, NO_UNDO_ACTIONS, nextStatus, type AnswerDecisionInput, type CeoAction, type InstructionSummary } from "@baton/shared";
import { toastId, useToasts } from "../state/toasts.ts";
import { useUi } from "../state/ui.ts";
import { api, isConflict } from "./client.ts";
import { findInstruction, removeInstruction, upsertDecision, upsertInstruction } from "./cache.ts";
import { qk } from "./keys.ts";

export type TransitionResult = { ok: true; instruction: InstructionSummary } | { ok: false; conflict: boolean };

export async function performTransition(qc: QueryClient, inst: InstructionSummary, action: CeoAction, comment?: string): Promise<TransitionResult> {
  const before = findInstruction(qc, inst.id) ?? inst;
  const to = action === "restore" ? null : nextStatus(before.status, action);
  // 楽観的に動かす（updatedAt は動かさない＝サーバーのイベントが必ず勝つ）
  if (to) upsertInstruction(qc, { ...before, status: to, statusChangedAt: Date.now(), openDecisionCount: to === "canceled" ? 0 : before.openDecisionCount }, { force: true });
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
    // 差し戻しのコメントは COO スレッドの発言になる（4.4）
    if (action === "send_back") void qc.invalidateQueries({ queryKey: ["messages"] });
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

/** 承認（許可・拒否）・中断からの再開・v1 の質問への回答（7.6・D-53） */
export async function answerDecision(qc: QueryClient, instructionId: string, decisionId: string, input: AnswerDecisionInput): Promise<boolean> {
  try {
    const res = await api.answerDecision(decisionId, input);
    upsertDecision(qc, res.decision);
    upsertInstruction(qc, res.instruction, { force: true });
    void qc.invalidateQueries({ queryKey: qk.sidebar });
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
