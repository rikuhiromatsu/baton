#!/usr/bin/env node
// デプロイ後の自動スモーク（v1 設計書 8.4、DESIGN-v2 15.4）。本番に対して読み取りだけの確認をする（状態を変えない）。
//   v1: / が 200、/manifest.webmanifest が 200、/api/session が 401、/api/test/login が 404、
//       /api/auth/login が accounts.google.com へ 302 で、redirect_uri が本番の URL
//   v2: /api/runner/ai/chat が 404・POST /api/instructions が 404（消した API）、/org・/settings が 200（SPA）、
//       /api/quota・/api/threads が 401、POST /mcp と /api/bot/v1/overview がトークン無しで 401（秘書 bot の入口）
//
// 使い方: node scripts/smoke-prod.mjs [URL]（既定は BATON_PROD_URL か https://baton.rikuhiromatsu.workers.dev）
const DEFAULT_URL = "https://baton.rikuhiromatsu.workers.dev";
const base = new URL(process.argv[2] ?? process.env.BATON_PROD_URL ?? DEFAULT_URL).origin;
const TIMEOUT_MS = 15_000;

async function request(method, path, init = {}) {
  return fetch(new URL(path, base), {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
    headers: { "User-Agent": "baton-smoke/1", ...(init.headers ?? {}) },
  });
}

const checks = [
  {
    name: "GET / が 200",
    run: async () => {
      const res = await request("GET", "/");
      expectStatus(res, 200);
      const html = await res.text();
      if (!/<html/i.test(html)) throw new Error("HTML が返っていない");
    },
  },
  {
    name: "GET /manifest.webmanifest が 200",
    run: async () => {
      const res = await request("GET", "/manifest.webmanifest");
      expectStatus(res, 200);
      const manifest = JSON.parse(await res.text());
      if (manifest.name !== "Baton") throw new Error(`name が Baton ではない: ${manifest.name}`);
    },
  },
  {
    name: "GET /api/session が 401",
    run: async () => {
      expectStatus(await request("GET", "/api/session"), 401);
    },
  },
  {
    name: "POST /api/test/login が 404（E2E 用の迂回が本番に無い）",
    run: async () => {
      const res = await request("POST", "/api/test/login", {
        headers: { "Content-Type": "application/json", "X-Baton-Test-Secret": "e2e-local-secret" },
        body: JSON.stringify({ email: "ceo@example.com" }),
      });
      expectStatus(res, 404);
      if (res.headers.get("set-cookie")) throw new Error("Cookie が発行された");
    },
  },
  {
    name: "GET /api/auth/login が Google へ 302（redirect_uri が本番）",
    run: async () => {
      const res = await request("GET", "/api/auth/login?redirect=/");
      expectStatus(res, 302);
      const location = res.headers.get("location");
      if (!location) throw new Error("Location ヘッダが無い");
      const url = new URL(location);
      if (url.hostname !== "accounts.google.com") throw new Error(`Google ではない: ${url.hostname}`);
      const redirectUri = url.searchParams.get("redirect_uri");
      const want = `${base}/api/auth/callback`;
      if (redirectUri !== want) throw new Error(`redirect_uri が ${redirectUri}（期待: ${want}）`);
      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE（S256）が付いていない");
      if (!url.searchParams.get("state")) throw new Error("state が無い");
    },
  },
  // ───── v2（15.4） ─────
  {
    name: "POST /api/runner/ai/chat が 404（Workers AI の代理を消した）",
    run: async () => {
      const res = await request("POST", "/api/runner/ai/chat", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      expectStatus(res, 404);
    },
  },
  {
    name: "POST /api/instructions が 404（CEO は指示を直接作らない。D-73）",
    run: async () => {
      const res = await request("POST", "/api/instructions", {
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ clientId: "00000000-0000-4000-8000-000000000000", body: "smoke" }),
      });
      expectStatus(res, 404);
    },
  },
  ...["/org", "/settings"].map((path) => ({
    name: `GET ${path} が 200（SPA）`,
    run: async () => {
      const res = await request("GET", path);
      expectStatus(res, 200);
      if (!/<html/i.test(await res.text())) throw new Error("HTML が返っていない");
    },
  })),
  ...["/api/quota", "/api/threads"].map((path) => ({
    name: `GET ${path} が 401`,
    run: async () => {
      expectStatus(await request("GET", path), 401);
    },
  })),
  {
    name: "POST /mcp がトークン無しで 401（秘書 bot の入口）",
    run: async () => {
      const res = await request("POST", "/mcp", {
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expectStatus(res, 401);
      if (res.headers.get("access-control-allow-origin")) throw new Error("CORS のヘッダを返している（ブラウザから呼ばせない。11.3）");
    },
  },
  {
    name: "POST /mcp が誤ったトークンで 401",
    run: async () => {
      const res = await request("POST", "/mcp", {
        headers: { "Content-Type": "application/json", Authorization: "Bearer btn_bot_smoke-invalid" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expectStatus(res, 401);
    },
  },
  {
    name: "GET /api/bot/v1/overview がトークン無しで 401",
    run: async () => {
      expectStatus(await request("GET", "/api/bot/v1/overview"), 401);
    },
  },
];

function expectStatus(res, want) {
  if (res.status !== want) throw new Error(`ステータスが ${res.status}（期待: ${want}）`);
}

console.log(`[smoke-prod] ${base}`);
let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`  ok    ${check.name}`);
  } catch (e) {
    failed++;
    const cause = e instanceof Error ? (e.cause instanceof Error ? `${e.message}（${e.cause.message}）` : e.message) : String(e);
    console.log(`  FAIL  ${check.name}: ${cause}`);
  }
}
if (failed > 0) {
  console.error(`[smoke-prod] ${failed} / ${checks.length} 件が失敗しました`);
  process.exit(1);
}
console.log(`[smoke-prod] すべて通りました（${checks.length} 件）`);
