// GET /api/session（v1 設計書 4.2・6.2、DESIGN-v2 10.3・11.6）
import { Hono } from "hono";
import { LIMITS, SessionInfoSchema, type SessionInfo } from "@baton/shared";
import { getRunnerStatus } from "../db/runners.ts";
import { DAY_MS } from "../lib/time.ts";
import { checked } from "../lib/validate.ts";
import { requireSession } from "../middleware/auth.ts";
import type { AppEnv } from "../types.ts";
import type { Env } from "../env.ts";
import type { UserRow } from "../db/rows.ts";

export const sessionInfoRoutes = new Hono<AppEnv>();

export async function sessionInfo(env: Env, user: Pick<UserRow, "id" | "email" | "name" | "picture_url">, csrfToken: string, now: number): Promise<SessionInfo> {
  return {
    user: { id: user.id, email: user.email, name: user.name, pictureUrl: user.picture_url },
    csrfToken,
    runner: await getRunnerStatus(env.DB, now),
    env: env.BATON_ENV,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
  };
}

sessionInfoRoutes.get("/", requireSession, async (c) => {
  const now = Date.now();
  // 期限切れのセッションと 90 日より古い bot の記録は、1% の確率でついでに掃除する（Cron は使わない）
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        c.env.DB.prepare("DELETE FROM bot_audit_log WHERE created_at < ?").bind(now - LIMITS.botAuditRetentionDays * DAY_MS),
      ]).then(() => undefined),
    );
  }
  const info = await sessionInfo(c.env, c.get("user"), c.get("session").csrf_token, now);
  return c.json(checked(c.env, SessionInfoSchema, info));
});
