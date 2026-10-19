// E1 未ログインで / → /login、login-google がある。テスト用ログインは条件が欠けると 404（v1 設計書 6.5）。
// v2: 秘書 bot の入口（/mcp・/api/bot/v1/*）も Cookie なし・トークンなしでは 401（11.3）。
// 「迂回なしの本番相当ビルドでは 404」そのものは、ビルド成果物の検査（scripts/assert-no-test-routes.mjs）と
// デプロイ後のスモーク（scripts/smoke-prod.mjs）で確かめる。ここでは e2e ビルドでも秘密が無ければ閉じていることを見る。
import { API_PATHS, TEST_API_PATHS, TEST_SECRET_HEADER, TESTIDS } from "@baton/shared";
import { CEO_EMAIL } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { mcpRaw } from "../helpers/mcp.ts";
import { byTestId } from "../helpers/ui.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test("E1 未ログインで / を開くとログイン画面に移る", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(?:[?#]|$)/);
  await expect(byTestId(page, TESTIDS.loginGoogle)).toBeVisible();
});

test("E1 未ログインの API は 401、秘密の無いテスト用ログインは 404", async ({ page }) => {
  const request = page.request;
  expect((await request.get(API_PATHS.session)).status()).toBe(401);
  expect((await request.get(API_PATHS.threads)).status()).toBe(401);
  expect((await request.get(API_PATHS.quota)).status()).toBe(401);

  const noSecret = await request.post(TEST_API_PATHS.testLogin, { data: { email: CEO_EMAIL } });
  expect(noSecret.status()).toBe(404);

  const wrongSecret = await request.post(TEST_API_PATHS.testLogin, {
    headers: { [TEST_SECRET_HEADER]: "wrong-secret" },
    data: { email: CEO_EMAIL },
  });
  expect(wrongSecret.status()).toBe(404);

  const runnerToken = await request.post(TEST_API_PATHS.testRunnerToken, { data: {} });
  expect(runnerToken.status()).toBe(404);

  // 迂回が失敗したので、セッションは作られていない
  expect((await request.get(API_PATHS.session)).status()).toBe(401);
});

test("E1 秘書 bot の入口はトークンが無いと 401", async ({ page }) => {
  const res = await mcpRaw(page.request, null, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  expect(res.status()).toBe(401);
  const wrong = await mcpRaw(page.request, "btn_bot_wrong", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  expect(wrong.status()).toBe(401);
  expect((await page.request.get(API_PATHS.botOverview)).status()).toBe(401);
});
