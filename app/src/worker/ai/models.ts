// 役割 → モデル（設計書 2.2・D-10）。主モデルは変数 MODEL_COO 等で上書きできる
import type { AiRole } from "@baton/shared";
import type { Env } from "../env.ts";

export const MODELS = {
  gptOss120b: "@cf/openai/gpt-oss-120b",
  gptOss20b: "@cf/openai/gpt-oss-20b",
  llama33: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  glm47flash: "@cf/zai-org/glm-4.7-flash",
  granite: "@cf/ibm-granite/granite-4.0-h-micro",
} as const;

export const MODEL_TABLE: Record<AiRole, { primary: string; fallback: string }> = {
  coo: { primary: MODELS.gptOss120b, fallback: MODELS.llama33 },
  leader: { primary: MODELS.glm47flash, fallback: MODELS.gptOss120b },
  member: { primary: MODELS.glm47flash, fallback: MODELS.gptOss20b },
  util: { primary: MODELS.glm47flash, fallback: MODELS.granite },
};

export function modelsFor(env: Env, role: AiRole): { primary: string; fallback: string } {
  const override = { coo: env.MODEL_COO, leader: env.MODEL_LEADER, member: env.MODEL_MEMBER, util: env.MODEL_UTIL }[role];
  const base = MODEL_TABLE[role];
  return { primary: override?.trim() || base.primary, fallback: base.fallback };
}
