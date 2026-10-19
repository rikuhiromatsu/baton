// W2〜W6: Google ログイン・オープンリダイレクト・セッション・CSRF
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, browser, call, callWithEnv, cookieFrom, login, ORIGIN } from "./helpers.ts";

const PROD = { BATON_ENV: "production" as const, APP_ORIGIN: "https://baton.rikuhiromatsu.workers.dev" };
const PROD_URL = "https://baton.rikuhiromatsu.workers.dev";

function b64url(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;
}

function goodClaims(over: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: env.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "CEO@example.com",
    email_verified: true,
    name: "本人",
    picture: "https://lh3.googleusercontent.com/a/x",
    ...over,
  };
}

/** Google のトークンエンドポイントを差し替える。呼ばれた中身を返す */
function mockGoogleToken(claims: Record<string, unknown>) {
  const calls: { url: string; body: string }[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://oauth2.googleapis.com/token") {
      calls.push({ url: req.url, body: await req.text() });
      return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken(claims) });
    }
    return real(input, init);
  });
  return calls;
}

/** /api/auth/login を呼んで state・Cookie を得る */
async function startLogin(overrides: Record<string, unknown> = {}, redirect = "/i/abc") {
  const origin = (overrides.APP_ORIGIN as string | undefined) ?? ORIGIN;
  const res = await callWithEnv(overrides, `${origin}/api/auth/login?redirect=${encodeURIComponent(redirect)}`);
  const location = new URL(res.headers.get("Location")!);
  const state = location.searchParams.get("state")!;
  const cookieState = cookieFrom(res, "baton_oauth_state")!;
  return { res, location, state, cookieState };
}

afterEach(() => vi.restoreAllMocks());

describe("W2 /api/auth/login", () => {
  it("state と PKCE を保存し、Google の URL に 302（S256）", async () => {
    const { res, location, state, cookieState } = await startLogin();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(cookieState).toBe(state);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/baton_oauth_state=.*HttpOnly/);
    expect(setCookie).toMatch(/Path=\/api\/auth/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const flow = await env.DB.prepare("SELECT * FROM oauth_flows WHERE state = ?").bind(state).first<{ code_verifier: string; redirect_to: string; expires_at: number; created_at: number }>();
    expect(flow).not.toBeNull();
    expect(flow!.redirect_to).toBe("/i/abc");
    expect(flow!.expires_at - flow!.created_at).toBe(600_000);
    // code_challenge は保存した verifier の S256
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow!.code_verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(location.searchParams.get("code_challenge")).toBe(expected);
  });

  it("本番では redirect_uri が本番の URL、state の Cookie は Secure", async () => {
    const { location, res } = await startLogin(PROD);
    expect(location.searchParams.get("redirect_uri")).toBe(`${PROD_URL}/api/auth/callback`);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/baton_oauth_state=.*Secure/);
  });
});

describe("W3 /api/auth/callback", () => {
  const callback = (origin: string, query: string, cookie: string | null, overrides: Record<string, unknown> = {}) =>
    callWithEnv(overrides, `${origin}/api/auth/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} });

  it("正常: 本番属性のセッション Cookie と redirect への 302", async () => {
    const calls = mockGoogleToken(goodClaims());
    const { state, cookieState } = await startLogin(PROD, "/i/xyz?tab=log");
    const res = await callback(PROD_URL, `code=good-code&state=${state}`, `baton_oauth_state=${cookieState}`, PROD);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/i/xyz?tab=log");
    const session = res.headers.getSetCookie().find((l) => l.startsWith("__Host-baton_session="));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=2592000/);
    expect(session).not.toMatch(/Domain=/i);
    // トークン交換に PKCE の verifier を送っている
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain("code=good-code");
    expect(calls[0]!.body).toContain("code_verifier=");
    // 利用者はメールを小文字にして保存。セッションは DB にハッシュだけ
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind("ceo@example.com").first<{ id: string; name: string }>();
    expect(user?.name).toBe("本人");
    const token = session!.split(";")[0]!.split("=")[1]!;
    const stored = await env.DB.prepare("SELECT id_hash FROM sessions WHERE user_id = ?").bind(user!.id).all<{ id_hash: string }>();
    expect(stored.results.map((r) => r.id_hash)).not.toContain(token);
    // state は使ったら消える
    expect(await env.DB.prepare("SELECT 1 FROM oauth_flows WHERE state = ?").bind(state).first()).toBeNull();
    // 作ったセッションで /api/session が通る（本番の Cookie 名）
    const info = await callWithEnv(PROD, `${PROD_URL}/api/session`, { headers: { Cookie: `__Host-baton_session=${token}` } });
    expect(info.status).toBe(200);
  });

  it("state 不一致は拒否", async () => {
    mockGoogleToken(goodClaims());
    const { state } = await startLogin();
    const res = await callback(ORIGIN, `code=c&state=${state}`, "baton_oauth_state=other");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?e=1");
    expect(cookieFrom(res, "baton_session")).toBeNull();
  });

  it("Cookie の state が無ければ拒否", async () => {
    mockGoogleToken(goodClaims());
    const { state } = await startLogin();
    const res = await callback(ORIGIN, `code=c&state=${state}`, null);
    expect(res.headers.get("Location")).toBe("/login?e=1");
  });

  it("期限切れは拒否", async () => {
    mockGoogleToken(goodClaims());
    const { state, cookieState } = await startLogin();
    await env.DB.prepare("UPDATE oauth_flows SET expires_at = ? WHERE state = ?").bind(Date.now() - 1, state).run();
    const res = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
    expect(res.headers.get("Location")).toBe("/login?e=1");
    expect(cookieFrom(res, "baton_session")).toBeNull();
  });

  it("再利用は拒否（2 回目）", async () => {
    mockGoogleToken(goodClaims());
    const { state, cookieState } = await startLogin();
    const first = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
    expect(first.headers.get("Location")).toBe("/i/abc");
    const second = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
    expect(second.headers.get("Location")).toBe("/login?e=1");
    expect(cookieFrom(second, "baton_session")).toBeNull();
  });

  it("許可リスト外は /login?e=forbidden で、ユーザーもセッションも作らない", async () => {
    mockGoogleToken(goodClaims({ email: "intruder@example.com" }));
    const { state, cookieState } = await startLogin();
    const res = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
    expect(res.headers.get("Location")).toBe("/login?e=forbidden");
    expect(cookieFrom(res, "baton_session")).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = 'intruder@example.com'").first()).toBeNull();
  });

  it("email_verified=false は拒否", async () => {
    mockGoogleToken(goodClaims({ email_verified: false }));
    const { state, cookieState } = await startLogin();
    const res = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
    expect(res.headers.get("Location")).toBe("/login?e=forbidden");
    expect(cookieFrom(res, "baton_session")).toBeNull();
  });

  it("iss・aud・exp が違えば拒否", async () => {
    for (const bad of [{ iss: "https://evil.example.com" }, { aud: "other-client" }, { exp: Math.floor(Date.now() / 1000) - 10 }]) {
      vi.restoreAllMocks();
      mockGoogleToken(goodClaims(bad));
      const { state, cookieState } = await startLogin();
      const res = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
      expect(res.headers.get("Location"), JSON.stringify(bad)).toBe("/login?e=1");
    }
  });

  it("トークン交換の失敗は拒否", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const { state, cookieState } = await startLogin();
    const res = await callback(ORIGIN, `code=c&state=${state}`, `baton_oauth_state=${cookieState}`);
    expect(res.headers.get("Location")).toBe("/login?e=1");
  });
});

describe("W4 オープンリダイレクト", () => {
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil.com", "javascript:alert(1)"]) {
    it(`${bad} は / に落とす`, async () => {
      const { state } = await startLogin({}, bad);
      const flow = await env.DB.prepare("SELECT redirect_to FROM oauth_flows WHERE state = ?").bind(state).first<{ redirect_to: string }>();
      expect(flow?.redirect_to).toBe("/");
    });
  }

  it("callback でも / に落ちる", async () => {
    mockGoogleToken(goodClaims());
    const { state, cookieState } = await startLogin({}, "//evil.com/x");
    const res = await callWithEnv({}, `${ORIGIN}/api/auth/callback?code=c&state=${state}`, { headers: { Cookie: `baton_oauth_state=${cookieState}` } });
    expect(res.headers.get("Location")).toBe("/");
  });
});

describe("W5 未ログインは 401", () => {
  it("Cookie 無し", async () => {
    const res = await call("/api/session");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect((await call("/api/instructions")).status).toBe(401);
  });

  it("でたらめな Cookie", async () => {
    expect((await call("/api/session", { headers: { Cookie: "baton_session=nope" } })).status).toBe(401);
  });

  it("期限切れ", async () => {
    const s = await login();
    expect((await browser(s, "/api/session")).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").bind(Date.now() - 1, s.userId).run();
    expect((await browser(s, "/api/session")).status).toBe(401);
  });

  it("ログアウト後", async () => {
    const s = await login();
    const out = await browser(s, "/api/auth/logout", { method: "POST" });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join("\n")).toMatch(/baton_session=;/);
    expect((await browser(s, "/api/session")).status).toBe(401);
  });

  it("許可リストから外れたら次のリクエストから 403", async () => {
    const s = await login("removed@example.com");
    const res = await browser(s, "/api/session");
    expect(res.status).toBe(403);
  });

  it("24 時間以上使っていないセッションは期限を延ばす", async () => {
    const s = await login();
    const old = Date.now() - 2 * 24 * 3600_000;
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE user_id = ?").bind(old, Date.now() + 1000, s.userId).run();
    const res = await browser(s, "/api/session");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/baton_session=.*Max-Age=2592000/);
    const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1").bind(s.userId).first<{ expires_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000);
  });

  it("GET /api/session は SessionInfo を返す", async () => {
    const s = await login();
    const info = (await (await browser(s, "/api/session")).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ user: { email: "ceo@example.com" }, csrfToken: s.csrf, env: "e2e", runner: { online: false } });
  });
});

describe("W6 CSRF", () => {
  const body = () => ({ clientId: crypto.randomUUID(), body: "CSRF のテスト" });

  it("ヘッダ無しは 403", async () => {
    const s = await login();
    const res = await browser(s, "/api/instructions", { body: body(), headers: { "X-Baton-CSRF": "" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("不一致は 403", async () => {
    const s = await login();
    expect((await browser(s, "/api/instructions", { body: body(), headers: { "X-Baton-CSRF": "wrong" } })).status).toBe(403);
  });

  it("別のセッションの CSRF トークンは 403", async () => {
    const a = await login();
    const b = await login();
    expect((await browser(a, "/api/instructions", { body: body(), headers: { "X-Baton-CSRF": b.csrf } })).status).toBe(403);
  });

  it("Origin 違い・Origin 無しは 403", async () => {
    const s = await login();
    expect((await browser(s, "/api/instructions", { body: body(), headers: { Origin: "https://evil.example.com" } })).status).toBe(403);
    const res = await call("/api/instructions", {
      method: "POST",
      headers: { Cookie: s.cookie, "X-Baton-CSRF": s.csrf, "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(403);
  });

  it("ログアウトも CSRF を見る", async () => {
    const s = await login();
    expect((await browser(s, "/api/auth/logout", { method: "POST", headers: { "X-Baton-CSRF": "x" } })).status).toBe(403);
  });

  it("一致すれば通る", async () => {
    const s = await login();
    expect((await browser(s, "/api/instructions", { body: body() })).status).toBe(201);
  });
});

describe("セキュリティヘッダ（6.6）", () => {
  it("API の応答に CSP 等が付く。HSTS は本番だけ", async () => {
    const res = await call("/api/session");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Content-Security-Policy")).toContain("ws://localhost:8790");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    const prod = await callWithEnv(PROD, `${PROD_URL}/api/session`);
    expect(prod.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(prod.headers.get("Content-Security-Policy")).not.toContain("ws://localhost");
    void BASE;
  });
});
