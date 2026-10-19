// e2e 専用のルート（v1 設計書 6.5）。index.ts の import.meta.env.MODE === "e2e" の中から動的 import される。
// 本番ビルドではこのファイルごと成果物に入らない。
import { Hono } from "hono";
import { SessionInfoSchema, TEST_API_PATHS, TestLoginInput, TestRunnerTokenOutput } from "@baton/shared";
import { newId, randomToken, sha256Hex } from "../lib/crypto.ts";
import { checked, readJson } from "../lib/validate.ts";
import { createSession, setSessionCookie } from "../middleware/auth.ts";
import type { AppEnv } from "../types.ts";
import { sessionInfo } from "./session.ts";

export const testOnlyRoutes = new Hono<AppEnv>();

testOnlyRoutes.post(TEST_API_PATHS.testLogin, async (c) => {
  const input = await readJson(c, TestLoginInput);
  const now = Date.now();
  const email = input.email.trim().toLowerCase();
  const user = (await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, picture_url, created_at, last_login_at) VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, last_login_at = excluded.last_login_at
     RETURNING id, email, name, picture_url`,
  )
    .bind(newId(), email, input.name ?? "", now, now)
    .first<{ id: string; email: string; name: string; picture_url: string | null }>())!;
  const { token, csrfToken } = await createSession(c.env.DB, user.id, c.req.header("User-Agent") ?? "", now);
  setSessionCookie(c, token);
  return c.json(checked(c.env, SessionInfoSchema, await sessionInfo(c.env, user, csrfToken, now)));
});

testOnlyRoutes.post(TEST_API_PATHS.testRunnerToken, async (c) => {
  const token = randomToken(32);
  const runnerId = newId();
  await c.env.DB.prepare("INSERT INTO runners (id, name, token_hash, status, revoked, created_at) VALUES (?, ?, ?, '{}', 0, ?)")
    .bind(runnerId, "e2e-runner", await sha256Hex(token), Date.now())
    .run();
  return c.json(checked(c.env, TestRunnerTokenOutput, { token, runnerId }));
});
