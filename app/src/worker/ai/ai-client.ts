// AI 呼び出しの差し替え口（設計書 8.2）。env.AI があれば WorkersAiClient、無ければ ScriptedAiClient
import type { Env } from "../env.ts";
import { ScriptedAiClient } from "./scripted-ai.ts";
import { WorkersAiClient } from "./workers-ai.ts";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

/** env.AI.run に渡す入力（Workers AI の Chat Completions 形式） */
export type AiRunInput = {
  messages: AiMessage[];
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown> } };
  max_completion_tokens: number;
  reasoning_effort?: "low" | "medium" | "high";
};

export interface AiClient {
  /** 生の戻り値を返す。形はモデルによって違う（normalizeAiResult で揃える） */
  chat(model: string, input: AiRunInput): Promise<unknown>;
}

/** Workers AI の日の無料枠切れ。retryAt を省くと次の UTC 0 時 */
export class AiQuotaError extends Error {
  readonly retryAt: number | null;
  constructor(message: string, retryAt: number | null = null) {
    super(message);
    this.retryAt = retryAt;
  }
}

export function createAiClient(env: Env): AiClient {
  return env.AI ? new WorkersAiClient(env.AI) : new ScriptedAiClient();
}
