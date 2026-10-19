// E2E 用のログイン迂回（設計書 6.5）。本物の Google ログインは通らない。
import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { API_PATHS, TEST_SECRET_HEADER, TestRunnerTokenOutput } from "@baton/shared";
import { expectOk } from "./api.ts";
import { BASE_URL, CEO_EMAIL, TEST_SECRET } from "./env.ts";

/** テスト用ログインで Cookie を受け取った APIRequestContext を返す（呼び出し側で dispose する） */
export async function loginAsCeo(email = CEO_EMAIL): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const res = await ctx.post(API_PATHS.testLogin, {
    headers: { [TEST_SECRET_HEADER]: TEST_SECRET },
    data: { email },
  });
  await expectOk(res, "POST /api/test/login");
  return ctx;
}

/** ランナー用のトークンを発行してもらう */
export async function issueRunnerToken(ctx: APIRequestContext): Promise<{ token: string; runnerId: string }> {
  const res = await ctx.post(API_PATHS.testRunnerToken, {
    headers: { [TEST_SECRET_HEADER]: TEST_SECRET },
    data: {},
  });
  await expectOk(res, "POST /api/test/runner-token");
  return TestRunnerTokenOutput.parse(await res.json());
}
