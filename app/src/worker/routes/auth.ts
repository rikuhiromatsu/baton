// Google ログイン（認可コード + PKCE + state。設計書 6.1）
import { hubStub } from "../hub/broadcast.ts";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { decodeIdToken, generateCodeVerifier, generateState, Google } from "arctic";
import type { Env } from "../env.ts";
import { newId } from "../lib/crypto.ts";
import { allowedEmails, clearSessionCookie, createSession, requireSession, setSessionCookie } from "../middleware/auth.ts";
import { requireCsrf } from "../middleware/csrf.ts";
import type { AppEnv } from "../types.ts";

export const OAUTH_STATE_COOKIE = "baton_oauth_state";
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** 同一オリジンのパスだけ許す（オープンリダイレクト対策）。だめなら "/" */
export function safeRedirect(value: string | undefined | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\r\n\t]/.test(value) || value.includes("\\")) return "/";
  return value;
}

export function googleClient(env: Env): Google {
  return new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${env.APP_ORIGIN}/api/auth/callback`);
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/login", async (c) => {
  const now = Date.now();
  const redirectTo = safeRedirect(c.req.query("redirect"));
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_flows WHERE expires_at < ?").bind(now),
    c.env.DB.prepare("INSERT INTO oauth_flows (state, code_verifier, redirect_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      state,
      codeVerifier,
      redirectTo,
      now,
      now + OAUTH_FLOW_TTL_MS,
    ),
  ]);
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/api/auth",
    maxAge: OAUTH_FLOW_TTL_MS / 1000,
    secure: c.env.BATON_ENV === "production",
  });
  const url = googleClient(c.env).createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString(), 302);
});

authRoutes.get("/callback", async (c) => {
  const fail = (e: string) => {
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/api/auth", secure: c.env.BATON_ENV === "production" });
    return c.redirect(`/login?e=${e}`, 302);
  };
  const now = Date.now();
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  if (!code || !state || !cookieState || cookieState !== state) return fail("1");

  // 照合したらすぐ消す（使い回し不可）
  const flow = await c.env.DB.prepare("DELETE FROM oauth_flows WHERE state = ? RETURNING code_verifier, redirect_to, expires_at")
    .bind(state)
    .first<{ code_verifier: string; redirect_to: string; expires_at: number }>();
  if (!flow || flow.expires_at <= now) return fail("1");

  let claims: Record<string, unknown>;
  try {
    const tokens = await googleClient(c.env).validateAuthorizationCode(code, flow.code_verifier);
    claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
  } catch (err) {
    console.warn("google token exchange failed", err);
    return fail("1");
  }
  // 署名は TLS で直接受け取ったので省略してよい（OIDC Core 3.1.3.7）。iss・aud・exp は見る
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(c.env.GOOGLE_CLIENT_ID) : aud === c.env.GOOGLE_CLIENT_ID;
  if (!GOOGLE_ISSUERS.has(String(claims.iss)) || !audOk || typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
    return fail("1");
  }
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (claims.email_verified !== true || !email || !allowedEmails(c.env).has(email)) return fail("forbidden");

  const name = typeof claims.name === "string" ? claims.name : "";
  const picture = typeof claims.picture === "string" ? claims.picture : null;
  const user = await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, picture_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, picture_url = excluded.picture_url, last_login_at = excluded.last_login_at
     RETURNING id`,
  )
    .bind(newId(), email, name, picture, now, now)
    .first<{ id: string }>();
  if (!user) return fail("1");
  const { token } = await createSession(c.env.DB, user.id, c.req.header("User-Agent") ?? "", now);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/api/auth", secure: c.env.BATON_ENV === "production" });
  setSessionCookie(c, token);
  return c.redirect(safeRedirect(flow.redirect_to), 302);
});

authRoutes.post("/logout", requireSession, requireCsrf, async (c) => {
  const idHash = c.get("session").id_hash;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
  // つないだままのリアルタイム配信も止める
  await hubStub(c.env).revokeSession(idHash);
  clearSessionCookie(c);
  return c.body(null, 204);
});
