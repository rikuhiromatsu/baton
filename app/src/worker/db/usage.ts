// AI の使用量（設計書 5.8）
import { LIMITS, type UsageToday } from "@baton/shared";
import { utcDay } from "../lib/time.ts";

/** Workers AI の無料枠切れを記録する行の model 名（byModel には出さない） */
export const QUOTA_HIT_MODEL = "__quota_hit__";

export async function usageToday(db: D1Database, now: number): Promise<UsageToday> {
  const day = utcDay(now);
  const [byModel, quota] = await db.batch([
    db
      .prepare(
        "SELECT model, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out FROM ai_usage WHERE day = ? AND model <> ? GROUP BY model ORDER BY model",
      )
      .bind(day, QUOTA_HIT_MODEL),
    db.prepare("SELECT max(created_at) AS at FROM ai_usage WHERE day = ? AND model = ?").bind(day, QUOTA_HIT_MODEL),
  ]);
  const rows = (byModel?.results ?? []) as { model: string; tokens_in: number; tokens_out: number }[];
  const items = rows.map((r) => ({ model: r.model, tokensIn: r.tokens_in ?? 0, tokensOut: r.tokens_out ?? 0 }));
  const quotaHitAt = ((quota?.results?.[0] as { at: number | null } | undefined)?.at ?? null) as number | null;
  return {
    day,
    tokensIn: items.reduce((s, r) => s + r.tokensIn, 0),
    tokensOut: items.reduce((s, r) => s + r.tokensOut, 0),
    byModel: items,
    quotaHitAt,
    dailyTokenLimit: LIMITS.tokensPerDay,
  };
}
