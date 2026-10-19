#!/usr/bin/env node
// デプロイ後の自動スモーク（設計書 8.4）。本番に対して読み取りだけの確認をする。
//   / が 200、/manifest.webmanifest が 200、/api/session が 401、/api/test/login が 404、
//   /api/auth/login が accounts.google.com へ 302 で、redirect_uri が本番の URL
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
