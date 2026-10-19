// 1 件の指示の処理（設計書 5.2 の 5 段階、5.7 判断待ち、5.8 AI 枠切れ、5.9 再開と取消）。
import type { ClaimOutput } from "@baton/shared";
import {
  AiQuotaError,
  AllWorkFailedError,
  ApiError,
  ConflictError,
  DecisionRequested,
  LimitError,
  NetworkError,
  StageFailedError,
  errorMessage,
  stopReasonOf,
} from "../errors.ts";
import { RunContext, type RunnerDeps } from "./context.ts";
import { runFinal, runRoute } from "./coo.ts";
import { runPlan, runReview } from "./leader.ts";
import { runWorkStage } from "./member.ts";
import { decideResume, type ResumePoint } from "./resume.ts";

export type RunOutcome =
  | "review" // 最終報告まで済んだ（answer_directly を含む）
  | "needs_decision"
  | "failed"
  | "released" // AI 枠切れ・通信の失敗で queued に戻した
  | "stopped" // 取消・停止（API はもう呼ばない）
  | "conflict"; // 409。もう握っていない

/** 次の UTC 0 時（Worker が retryAt を返さなかったときの再開予定） */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

async function orchestrate(ctx: RunContext, start: ResumePoint): Promise<void> {
  let point: ResumePoint = start;
  for (;;) {
    ctx.throwIfStopped();
    switch (point.stage) {
      case "route": {
        const r = await runRoute(ctx);
        if (r === "answered") return;
        point = { stage: "plan", round: 1 };
        break;
      }
      case "plan":
        await runPlan(ctx, point.round);
        point = { stage: "work", round: point.round };
        break;
      case "work":
        if (point.retryFailed) {
          for (const t of ctx.workTasks(point.round)) {
            if (t.status === "failed" || t.status === "canceled") await ctx.patchTask(t.id, { status: "pending", resultSummary: null });
          }
        }
        await runWorkStage(ctx, point.round);
        point = { stage: "review", round: point.round, reopen: false };
        break;
      case "review": {
        const r = await runReview(ctx, point.round, point.reopen);
        point = r.revised ? { stage: "work", round: r.round } : { stage: "final", round: point.round };
        break;
      }
      case "final":
        await runFinal(ctx, point.round);
        return;
    }
  }
}

/** 指示を failed にする（error に理由）。届かなければ release して lease 切れに任せる */
async function fail(deps: RunnerDeps, ctx: RunContext | null, instructionId: string, message: string, signal: AbortSignal): Promise<RunOutcome> {
  const error = message.slice(0, 4000);
  try {
    if (ctx) await ctx.events.emit({ taskId: null, agentId: null, kind: "error", content: { message: error } }).catch(() => undefined);
    await deps.api.patchInstruction(instructionId, { status: "failed", error }, { signal });
    deps.log.warn("指示を失敗にしました", { instructionId, error });
    return "failed";
  } catch (err) {
    if (signal.aborted || err instanceof ConflictError) return err instanceof ConflictError ? "conflict" : "stopped";
    deps.log.error("失敗の記録に失敗", { instructionId, error: errorMessage(err) });
    await deps.api.release(instructionId, { reason: "error", notBefore: null, error }, { signal }).catch(() => undefined);
    return "released";
  }
}

/**
 * claim した指示を最後まで（または判断待ち・停止まで）進める。例外は投げない。
 * signal は scheduler の AbortController。取消・停止のときは API を呼ばずに戻る（停止時の release は scheduler が行う）。
 */
export async function runInstruction(deps: RunnerDeps, claim: ClaimOutput, signal: AbortSignal): Promise<RunOutcome> {
  const id = claim.instruction.id;
  const log = deps.log;
  let ctx: RunContext | null = null;
  try {
    const state = await deps.api.getState(id, { signal });
    ctx = new RunContext(deps, state, signal);
    const point = decideResume(state);
    log.info("指示の処理を始めます", { instructionId: id, attempt: state.instruction.attempt, resume: claim.resume, stage: point.stage });
    if (claim.resume || point.stage !== "route") {
      await ctx.events.emit({ taskId: null, agentId: null, kind: "note", content: { message: "続きから再開します", resumePoint: point, attempt: state.instruction.attempt } });
    }
    await orchestrate(ctx, point);
    return "review";
  } catch (err) {
    if (signal.aborted) {
      log.info("指示の処理を止めました", { instructionId: id, reason: stopReasonOf(signal) });
      return "stopped";
    }
    if (err instanceof DecisionRequested) return "needs_decision";
    if (err instanceof ConflictError) {
      log.warn("409: この指示はもう握っていません。処理を打ち切ります", { instructionId: id, error: err.message });
      return "conflict";
    }
    if (err instanceof AiQuotaError) {
      if (err.scope === "instruction") return fail(deps, ctx, id, `上限: トークン（指示あたり）`, signal);
      const notBefore = err.retryAt ?? nextUtcMidnight((deps.now ?? Date.now)());
      log.warn("AI の枠切れ。queued に戻します", { instructionId: id, notBefore });
      try {
        await ctx?.events.emit({ taskId: null, agentId: null, kind: "note", content: { message: "AI の利用枠が尽きたため、再開予定時刻まで待ちます", notBefore } });
        await deps.api.release(id, { reason: "ai_quota", notBefore }, { signal });
      } catch (e) {
        log.error("release に失敗", { instructionId: id, error: errorMessage(e) });
      }
      return "released";
    }
    if (err instanceof LimitError || err instanceof AllWorkFailedError || err instanceof StageFailedError) {
      return fail(deps, ctx, id, err.message, signal);
    }
    if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
      // Worker に届かない・Worker の障害。失敗にせず queued に戻して後で取り直す
      log.error("Worker との通信に失敗。queued に戻します", { instructionId: id, error: errorMessage(err) });
      await deps.api.release(id, { reason: "error", notBefore: (deps.now ?? Date.now)() + 60_000, error: errorMessage(err).slice(0, 4000) }, { signal }).catch(() => undefined);
      return "released";
    }
    log.error("想定外のエラー", { instructionId: id, error: errorMessage(err), stack: (err as Error)?.stack });
    return fail(deps, ctx, id, `ランナーのエラー: ${errorMessage(err)}`, signal);
  }
}
