// POST /api/runner/ai/chat（設計書 5.8・D-4）
import { Hono } from "hono";
import { AiChatInput, AiChatOutput } from "@baton/shared";
import { aiChat } from "../../ai/proxy.ts";
import { checked, readJson } from "../../lib/validate.ts";
import type { AppEnv } from "../../types.ts";
import { requireLease } from "./lease.ts";

export const runnerAiRoutes = new Hono<AppEnv>();

runnerAiRoutes.post("/chat", async (c) => {
  const input = await readJson(c, AiChatInput);
  await requireLease(c.env.DB, input.instructionId, c.get("runner").id);
  return c.json(checked(c.env, AiChatOutput, await aiChat(c.env, input)));
});
