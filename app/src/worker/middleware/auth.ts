// セッション Cookie の認証（設計書 6.2）
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { DAY_MS } from "../lib/time.ts";
import type { SessionRow, UserRow } from "../db/rows.ts";
import type { Env } from "../env.ts";
import type { AppEnv } from "../types.ts";

export const SESSION_TTL_MS = 30 * DAY_MS;
export const SESSION_TOUCH_INTERVAL_MS = DAY_MS;

/** 本番は __Host- 付き＋Secure。ローカル・e2e は付けない（D-29） */
export function sessionCookieName(env: Pick<Env, "BATON_ENV">): string {
  return env.BATON_ENV === "production" ? "__Host-baton_session" : "baton_session";
}

const SESSION_COOKIE_BASE = "baton_session";

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  const prod = c.env.BATON_ENV === "production";
  // 本番は prefix: "host" で __Host-baton_session になる
  setCookie(c, SESSION_COOKIE_BASE, token, {
    httpOnly: true,
    secure: prod,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    ...(prod ? { prefix: "host" as const } : {}),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  const prod = c.env.BATON_ENV === "production";
  deleteCookie(c, SESSION_COOKIE_BASE, { path: "/", secure: prod, ...(prod ? { prefix: "host" as const } : {}) });
}

export function allowedEmails(env: Pick<Env, "ALLOWED_EMAILS">): Set<string> {
  return new Set(
    (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** 新しいセッションを作り、トークン本体と CSRF トークンを返す */
export async function createSession(db: D1Database, userId: string, userAgent: string, now: number) {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  await db
    .prepare(
      "INSERT INTO sessions (id_hash, user_id, csrf_token, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), userId, csrfToken, userAgent.slice(0, 300), now, now, now + SESSION_TTL_MS)
    .run();
  return { token, csrfToken };
}

/** Cookie からセッションと利用者を引く。無ければ null */
export async function readSession(c: Context<AppEnv>): Promise<{ session: SessionRow; user: UserRow } | null> {
  const token = c.env.BATON_ENV === "production" ? getCookie(c, SESSION_COOKIE_BASE, "host") : getCookie(c, SESSION_COOKIE_BASE);
  if (!token) return null;
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.*, u.email AS u_email, u.name AS u_name, u.picture_url AS u_picture_url,
            u.created_at AS u_created_at, u.last_login_at AS u_last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), now)
    .first<SessionRow & { u_email: string; u_name: string; u_picture_url: string | null; u_created_at: number; u_last_login_at: number }>();
  if (!row) return null;
  const session: SessionRow = {
    id_hash: row.id_hash,
    user_id: row.user_id,
    csrf_token: row.csrf_token,
    user_agent: row.user_agent,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
  };
  const user: UserRow = {
    id: row.user_id,
    email: row.u_email,
    name: row.u_name,
    picture_url: row.u_picture_url,
    created_at: row.u_created_at,
    last_login_at: row.u_last_login_at,
  };
  // 最終利用から 24 時間以上たっていたら期限を延ばす（毎回は書かない）
  if (now - session.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
    session.last_seen_at = now;
    session.expires_at = now + SESSION_TTL_MS;
    await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?")
      .bind(now, session.expires_at, session.id_hash)
      .run();
  }
  return { session, user };
}

/** ログイン必須。許可リストから外れたメールは次のリクエストから 403 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const found = await readSession(c);
  if (!found) throw new ApiError("unauthorized", "login required");
  if (!allowedEmails(c.env).has(found.user.email.toLowerCase())) throw new ApiError("forbidden", "not allowed");
  c.set("session", found.session);
  c.set("user", found.user);
  await next();
};
