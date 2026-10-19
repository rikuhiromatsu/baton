// GET /api/session（設計書 4.2・6.2）
import { Hono } from "hono";
import { SessionInfoSchema, type SessionInfo } from "@baton/shared";
import { getRunnerStatus } from "../db/runners.ts";
import { checked } from "../lib/validate.ts";
import { requireSession } from "../middleware/auth.ts";
import type { AppEnv } from "../types.ts";

export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.get("/", requireSession, async (c) => {
  const now = Date.now();
  const user = c.get("user");
  // 期限切れのセッションは 1% の確率でついでに掃除する（Cron は使わない）
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run().then(() => undefined));
  }
  const info: SessionInfo = {
    user: { id: user.id, email: user.email, name: user.name, pictureUrl: user.picture_url },
    csrfToken: c.get("session").csrf_token,
    runner: await getRunnerStatus(c.env.DB, now),
    env: c.env.BATON_ENV,
  };
  return c.json(checked(c.env, SessionInfoSchema, info));
});
