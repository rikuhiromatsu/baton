// 本物の Workers AI（env.AI.run）
import { AiQuotaError, type AiClient, type AiRunInput } from "./ai-client.ts";

/** Free プランの日の無料枠（10,000 Neurons）切れのエラーか */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b4006\b|daily free allocation|neurons? (limit|allocation)|used up your daily/i.test(msg);
}

export class WorkersAiClient implements AiClient {
  private readonly ai: Ai;
  constructor(ai: Ai) {
    this.ai = ai;
  }

  async chat(model: string, input: AiRunInput): Promise<unknown> {
    try {
      // モデルごとに入力の型が違うため、ここだけ型を外す
      return await (this.ai.run as (m: string, i: unknown) => Promise<unknown>)(model, input);
    } catch (err) {
      if (isQuotaError(err)) throw new AiQuotaError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
