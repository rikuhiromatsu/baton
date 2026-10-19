// AI 呼び出し（設計書 5.6・2.2 D-11）。
// - 503・タイムアウト・ネットワーク: 2 秒→8 秒で 2 回、それでもだめなら退避先モデル（preferFallback）で 1 回
// - JSON の検査失敗: 同じモデルに JSON_ERROR を付けて 1 回、だめなら退避先で 1 回、だめなら段階の失敗
// - 429 ai_quota・409・取消はそのまま上に投げる
import { parseStageAction, stageJsonSchema, type AiRole, type AskCeo, type Stage, STAGE_SCHEMAS } from "@baton/shared";
import type { z } from "zod";
import { AiQuotaError, ApiError, ConflictError, DecisionRequested, LimitError, NetworkError, StageFailedError, errorMessage, isAbortError } from "../errors.ts";
import { askLimitMessage, jsonErrorMessage, type ChatMessage } from "../prompts/util.ts";
import { sleep } from "../sync.ts";
import type { RunContext } from "./context.ts";

export type StageAction<S extends Stage> = z.infer<(typeof STAGE_SCHEMAS)[S]>;

export type StageCall<S extends Stage> = {
  stage: S;
  role: AiRole;
  messages: ChatMessage[];
  taskId: string | null;
  agentId: string | null;
  signal?: AbortSignal;
  /** スキーマは通ったが意味が合わないとき、直し依頼の文を返す */
  validate?: (action: StageAction<S>) => string | null;
};

function isAiRetryable(err: unknown): boolean {
  if (err instanceof AiQuotaError || err instanceof ConflictError) return false;
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) return err.status >= 500 || err.code === "ai_unavailable" || err.code === "rate_limited";
  if (isAbortError(err)) return true; // 自分の 120 秒タイムアウト（親の中止は先に判定する）
  return true;
}

function maxTokensFor(ctx: RunContext, role: AiRole): number {
  return ctx.limits.maxCompletionTokens[role];
}

/** 1 回分の応答を得る（503 等の再試行と退避先を含む） */
async function chatOnce(ctx: RunContext, call: StageCall<Stage>, messages: ChatMessage[], preferFallback: boolean): Promise<{ text: string; model: string }> {
  const signal = call.signal ?? ctx.signal;
  const delays = ctx.config.aiRetryDelaysMs;
  let fallback = preferFallback;
  let fallbackTried = preferFallback;
  for (let i = 0; ; i++) {
    if (signal.aborted) throw signal.reason;
    ctx.budget.beforeAiCall();
    const release = await ctx.deps.aiSemaphore.acquire(signal);
    const t0 = ctx.now();
    let out: Awaited<ReturnType<typeof ctx.api.aiChat>>;
    try {
      out = await ctx.api.aiChat(
        {
          instructionId: ctx.id,
          role: call.role,
          messages,
          jsonSchema: stageJsonSchema(call.stage),
          maxCompletionTokens: maxTokensFor(ctx, call.role),
          ...(fallback ? { preferFallback: true } : {}),
        },
        { signal },
      );
    } catch (err) {
      release();
      if (signal.aborted) throw signal.reason;
      if (err instanceof AiQuotaError || err instanceof ConflictError || err instanceof LimitError) throw err;
      const msg = errorMessage(err);
      ctx.deps.stats.lastAiError = { at: ctx.now(), instructionId: ctx.id, message: msg };
      ctx.log.warn("AI 呼び出しに失敗", { instructionId: ctx.id, stage: call.stage, error: msg });
      await ctx.events.emit({ taskId: call.taskId, agentId: call.agentId, kind: "error", content: { stage: call.stage, message: `AI 呼び出しに失敗: ${msg}` } });
      if (!isAiRetryable(err)) throw new StageFailedError(`AI 呼び出しに失敗しました（${call.stage}）: ${msg}`);
      const delay = delays[i];
      if (delay !== undefined && !fallback) {
        await sleep(delay, signal);
        continue;
      }
      if (!fallbackTried) {
        fallback = true;
        fallbackTried = true;
        continue;
      }
      throw new StageFailedError(`AI を呼び出せませんでした（${call.stage}。再試行と退避先も失敗）: ${msg}`);
    }
    release();
    ctx.budget.addUsage(out.usage.tokensIn, out.usage.tokensOut);
    await ctx.events.emit({
      taskId: call.taskId,
      agentId: call.agentId,
      kind: "llm_call",
      content: { stage: call.stage, role: call.role, usedFallback: out.usedFallback, preferFallback: fallback, messages: messages.length },
      model: out.model,
      tokensIn: out.usage.tokensIn,
      tokensOut: out.usage.tokensOut,
      durationMs: Math.max(0, Math.round(ctx.now() - t0)),
    });
    return { text: out.text, model: out.model };
  }
}

/**
 * 段階の JSON アクションを 1 個得る。検査に失敗したら JSON_ERROR を付けて同じモデルで 1 回、退避先で 1 回。
 */
export async function callStage<S extends Stage>(ctx: RunContext, call: StageCall<S>): Promise<{ action: StageAction<S>; text: string }> {
  let messages = call.messages;
  let problem = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text } = await chatOnce(ctx, call as StageCall<Stage>, messages, attempt === 2);
    let action: StageAction<S> | null = null;
    try {
      action = parseStageAction(call.stage, text) as StageAction<S>;
      problem = call.validate?.(action) ?? "";
    } catch (err) {
      problem = describeParseError(err);
    }
    if (action && !problem) return { action, text };
    await ctx.events.emit({ taskId: call.taskId, agentId: call.agentId, kind: "error", content: { stage: call.stage, message: `JSON の検査に失敗: ${problem}`, attempt: attempt + 1 } });
    messages = [...call.messages, { role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: jsonErrorMessage(problem) }];
  }
  throw new StageFailedError(`AI の出力が形式に合いませんでした（${call.stage}）: ${problem}`);
}

function describeParseError(err: unknown): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues) && issues.length) {
    return issues
      .slice(0, 8)
      .map((i) => `${i.path.map(String).join(".") || "(全体)"}: ${i.message}`)
      .join(" / ");
  }
  return errorMessage(err);
}

/**
 * ask_ceo を扱う版。判断が残っていれば ask を返し、使い切っていれば「最善の仮定で進めて」と 1 回だけ返して続けさせる（5.7）。
 */
export async function callStageWithAsk<S extends Exclude<Stage, "coo_final" | "member_step">>(
  ctx: RunContext,
  call: StageCall<S>,
): Promise<{ kind: "action"; action: Exclude<StageAction<S>, AskCeo> } | { kind: "ask"; ask: AskCeo }> {
  const first = await callStage(ctx, call);
  if (first.action.kind !== "ask_ceo") return { kind: "action", action: first.action as Exclude<StageAction<S>, AskCeo> };
  if (ctx.decisionsLeft() > 0) return { kind: "ask", ask: first.action as AskCeo };
  await ctx.events.emit({ taskId: call.taskId, agentId: call.agentId, kind: "note", content: { stage: call.stage, message: "判断の上限に達したため、仮定を置いて進めるよう依頼" } });
  const retry = await callStage(ctx, {
    ...call,
    messages: [...call.messages, { role: "assistant", content: first.text.slice(0, 4000) }, { role: "user", content: askLimitMessage(ctx.limits.decisionsPerInstruction) }],
    validate: (a) => (a.kind === "ask_ceo" ? "ask_ceo はもう使えません。最善の仮定を置いて ask_ceo 以外の kind で答えてください" : (call.validate?.(a) ?? null)),
  });
  return { kind: "action", action: retry.action as Exclude<StageAction<S>, AskCeo> };
}

/** CEO への判断を作り、この指示の処理を終える（5.7）。event を先に送る（判断を作ると lease が外れるため） */
export async function askCeo(ctx: RunContext, ask: AskCeo, opts: { taskId: string | null; agentId: string | null; stage: string }): Promise<never> {
  await ctx.events.emit({ taskId: opts.taskId, agentId: opts.agentId, kind: "decision", content: { stage: opts.stage, question: ask.question, options: ask.options } });
  const decision = await ctx.api.createDecision(
    { instructionId: ctx.id, taskId: opts.taskId, askedByAgentId: opts.agentId, question: ask.question, options: ask.options },
    { signal: ctx.signal },
  );
  ctx.log.info("CEO の判断待ちにしました", { instructionId: ctx.id, decisionId: decision.id, stage: opts.stage });
  throw new DecisionRequested(decision.id);
}
