// W16 テスト用ルート: e2e の 4 条件のどれか 1 つでも欠けると 404。v2 で消した経路と未知の /api/* は認証より前に 404（12.1・15.4）。
// W17 run_worker_first で /api/auth/callback が Worker に届く
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TEST_API_PATHS, TEST_SECRET_HEADER } from "@baton/shared";
import { testRoutesAllowed } from "../../src/worker/routes/test-gate.ts";
import { call, callWithEnv, TEST_SECRET } from "./helpers.ts";

const loginInit = (secret: string | null): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(secret === null ? {} : { [TEST_SECRET_HEADER]: secret }) },
  body: JSON.stringify({ email: "ceo@example.com" }),
});

describe("W16 テスト用ルート", () => {
  it("4 条件がそろえば login と runner-token が使える（login は Cookie と csrfToken を返す）", async () => {
    const res = await call(TEST_API_PATHS.testLogin, loginInit(TEST_SECRET));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/baton_session=/);
    expect(((await res.json()) as { csrfToken: string }).csrfToken).toBeTruthy();
    const tok = await call(TEST_API_PATHS.testRunnerToken, { method: "POST", headers: { [TEST_SECRET_HEADER]: TEST_SECRET } });
    expect(tok.status).toBe(200);
    const { token } = (await tok.json()) as { token: string };
    const claim = await call("/api/runner/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kinds: ["thread"], activeThreadIds: [], activeInstructionIds: [], quotaPaused: false }),
    });
    expect([200, 204]).toContain(claim.status);
  });

  it("BATON_ENV=production では 404", async () => {
    const res = await callWithEnv({ BATON_ENV: "production" }, `http://localhost:8790${TEST_API_PATHS.testLogin}`, loginInit(TEST_SECRET));
    expect(res.status).toBe(404);
    const tok = await callWithEnv({ BATON_ENV: "production" }, `http://localhost:8790${TEST_API_PATHS.testRunnerToken}`, { method: "POST", headers: { [TEST_SECRET_HEADER]: TEST_SECRET } });
    expect(tok.status).toBe(404);
  });

  it("BATON_ENV=development でも 404", async () => {
    expect((await callWithEnv({ BATON_ENV: "development" }, `http://localhost:8790${TEST_API_PATHS.testLogin}`, loginInit(TEST_SECRET))).status).toBe(404);
  });

  it("localhost 以外のホストは 404（127.0.0.1 は通る）", async () => {
    expect((await callWithEnv({}, `https://baton.rikuhiromatsu.workers.dev${TEST_API_PATHS.testLogin}`, loginInit(TEST_SECRET))).status).toBe(404);
    expect((await callWithEnv({}, `http://127.0.0.1:8790${TEST_API_PATHS.testLogin}`, loginInit(TEST_SECRET))).status).toBe(200);
  });

  it("秘密が無い・違う・サーバーに未設定なら 404", async () => {
    expect((await call(TEST_API_PATHS.testLogin, loginInit(null))).status).toBe(404);
    expect((await call(TEST_API_PATHS.testLogin, loginInit("wrong"))).status).toBe(404);
    expect((await callWithEnv({ E2E_TEST_SECRET: undefined }, TEST_API_PATHS.testLogin, loginInit(TEST_SECRET))).status).toBe(404);
    expect((await callWithEnv({ E2E_TEST_SECRET: "" }, TEST_API_PATHS.testLogin, loginInit(""))).status).toBe(404);
  });

  it("ビルド時の MODE が e2e でなければ通さない（判定関数）", () => {
    const e2eEnv = { BATON_ENV: "e2e" as const, E2E_TEST_SECRET: TEST_SECRET };
    const url = "http://localhost:8790/api/test/login";
    expect(testRoutesAllowed("e2e", e2eEnv, url, TEST_SECRET)).toBe(true);
    expect(testRoutesAllowed("production", e2eEnv, url, TEST_SECRET)).toBe(false);
    expect(testRoutesAllowed("development", e2eEnv, url, TEST_SECRET)).toBe(false);
    expect(testRoutesAllowed("test", e2eEnv, url, TEST_SECRET)).toBe(false);
  });
});

describe("W16 消した経路・未知の経路は認証より前に 404（12.1・15.4）", () => {
  const cases: [string, string][] = [
    ["POST", "/api/runner/ai/chat"],
    ["POST", "/api/instructions"],
    ["GET", "/api/usage/today"],
    ["GET", "/api/instructions/abc/events"],
    ["GET", "/api/runner/instructions/abc/state"],
    ["GET", "/api/nope"],
    ["DELETE", "/api/threads"],
  ];
  for (const [method, path] of cases) {
    it(`${method} ${path} は 404（Cookie もトークンも無しで）`, async () => {
      const res = await call(path, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    });
  }

  it("ある経路は従来どおり 401（ブラウザ・ランナー・秘書 bot）", async () => {
    expect((await call("/api/threads")).status).toBe(401);
    expect((await call("/api/quota")).status).toBe(401);
    expect((await call("/api/threads/thread-coo/messages", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/api/runner/claim", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/api/bot/v1/overview")).status).toBe(401);
    expect((await call("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("W17 run_worker_first", () => {
  it("wrangler.jsonc で /api/* を Worker 優先にしていて、移動リクエストの /api/auth/callback が Worker に届く", async () => {
    const assets = JSON.parse(env.TEST_ASSETS_CONFIG) as { not_found_handling?: string; run_worker_first?: string[] } | null;
    expect(assets?.not_found_handling).toBe("single-page-application");
    expect(assets?.run_worker_first).toEqual(expect.arrayContaining(["/api/*"]));
    const res = await call("/api/auth/callback?code=x&state=y", {
      headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Accept: "text/html" },
      redirect: "manual",
    });
    // SPA の index.html（200）ではなく、Worker のコールバック処理（失敗で /login?e=1 へ 302）
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?e=1");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});
