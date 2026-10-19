// POST /api/runner/ai/chat の本体（設計書 5.8）: 上限の確認 → モデル選択 → 呼び出し → 正規化 → 使用量の記録
import { LIMITS, type AiChatInput, type AiChatOutput } from "@baton/shared";
import type { Env } from "../env.ts";
import { QUOTA_HIT_MODEL, usageToday } from "../db/usage.ts";
import { publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { nextUtcMidnight, utcDay } from "../lib/time.ts";
import { AiQuotaError, createAiClient, type AiClient, type AiRunInput } from "./ai-client.ts";
import { modelsFor } from "./models.ts";
import { estimateTokens, extractFirstJsonObject, normalizeAiResult } from "./normalize.ts";

export async function aiChat(env: Env, input: AiChatInput, client: AiClient = createAiClient(env)): Promise<AiChatOutput> {
  const db = env.DB;
  const now = Date.now();
  const day = utcDay(now);

  // 1. 日上限（と、今日すでに無料枠切れが記録されているか）
  const [dayTotal, quotaHit, inst] = await db.batch([
    db.prepare("SELECT coalesce(sum(tokens_in + tokens_out), 0) AS n FROM ai_usage WHERE day = ?").bind(day),
    db.prepare("SELECT max(created_at) AS at FROM ai_usage WHERE day = ? AND model = ?").bind(day, QUOTA_HIT_MODEL),
    db.prepare("SELECT tokens_in + tokens_out AS n FROM instructions WHERE id = ?").bind(input.instructionId),
  ]);
  const retryAt = nextUtcMidnight(now);
  const used = ((dayTotal?.results?.[0] as { n: number } | undefined)?.n ?? 0) as number;
  if (used >= LIMITS.tokensPerDay) {
    throw new ApiError("ai_quota", "daily token limit reached", { scope: "day", retryAt, limit: LIMITS.tokensPerDay });
  }
  if (((quotaHit?.results?.[0] as { at: number | null } | undefined)?.at ?? null) !== null) {
    throw new ApiError("ai_quota", "Workers AI free allocation used up today", { scope: "provider", retryAt });
  }
  // 2. 指示上限
  const instUsed = ((inst?.results?.[0] as { n: number } | undefined)?.n ?? 0) as number;
  if (instUsed >= LIMITS.tokensPerInstruction) {
    throw new ApiError("ai_quota", "instruction token limit reached", { scope: "instruction", retryAt: null, limit: LIMITS.tokensPerInstruction });
  }

  // 3. 役割 → モデル
  const { primary, fallback } = modelsFor(env, input.role);
  const base: AiRunInput = {
    messages: input.messages,
    max_completion_tokens: input.maxCompletionTokens,
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
  };
  const withSchema: AiRunInput | null = input.jsonSchema
    ? { ...base, response_format: { type: "json_schema", json_schema: { name: input.jsonSchema.name, schema: input.jsonSchema.schema } } }
    : null;

  /** 1 つのモデルで呼ぶ。response_format を拒否されたら付けずにもう 1 回 */
  const callModel = async (model: string): Promise<unknown> => {
    if (withSchema) {
      try {
        return await client.chat(model, withSchema);
      } catch (err) {
        if (err instanceof AiQuotaError) throw err;
        console.warn(`ai ${model} rejected response_format, retrying without it`, err);
      }
    }
    return client.chat(model, base);
  };

  let raw: unknown;
  let model = input.preferFallback ? fallback : primary;
  let usedFallback = model === fallback && model !== primary;
  try {
    try {
      raw = await callModel(model);
    } catch (err) {
      if (err instanceof AiQuotaError || usedFallback) throw err;
      // 5. その他のエラーは退避先モデルで 1 回
      console.warn(`ai ${model} failed, falling back to ${fallback}`, err);
      model = fallback;
      usedFallback = true;
      raw = await callModel(model);
    }
  } catch (err) {
    if (err instanceof AiQuotaError) {
      // 4. 無料枠切れ: 記録して 429（retryAt = 次の UTC 0 時。台本の AI は自分で決めた時刻）
      const at = err.retryAt ?? retryAt;
      if (err.retryAt === null) {
        await db
          .prepare("INSERT INTO ai_usage (id, day, model, role, instruction_id, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)")
          .bind(newId(), day, QUOTA_HIT_MODEL, input.role, input.instructionId, now)
          .run();
        await publish(env, [{ t: "usage.updated", usage: await usageToday(db, now) }]);
      }
      throw new ApiError("ai_quota", "Workers AI quota exhausted", { scope: "provider", retryAt: at });
    }
    throw new ApiError("ai_unavailable", "AI call failed", { message: err instanceof Error ? err.message : String(err) });
  }

  // 6. 正規化と使用量の記録
  const norm = normalizeAiResult(raw);
  let text = norm.text;
  if (input.jsonSchema) text = extractFirstJsonObject(text) ?? text;
  const promptChars = input.messages.reduce((n, m) => n + m.content.length, 0);
  const usage = norm.usage ?? { tokensIn: Math.ceil(promptChars / 3), tokensOut: estimateTokens(norm.text) };
  const done = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO ai_usage (id, day, model, role, instruction_id, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), utcDay(done), model, input.role, input.instructionId, usage.tokensIn, usage.tokensOut, done),
    db
      .prepare("UPDATE instructions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? WHERE id = ?")
      .bind(usage.tokensIn, usage.tokensOut, done, input.instructionId),
  ]);
  await publish(env, [{ t: "usage.updated", usage: await usageToday(db, done) }]);
  return { text, model, usedFallback, usage };
}
