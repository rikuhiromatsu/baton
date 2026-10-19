// Worker のバインディングと変数（v1 設計書 9.3・9.6、DESIGN-v2 10.3・12.1）。
// v2 で消したもの: AI（Workers AI）・MODEL_*（D-40）。
import type { BatonEnv } from "@baton/shared";
import type { BatonHub } from "./hub/batonhub.ts";

export type Env = {
  DB: D1Database;
  HUB: DurableObjectNamespace<BatonHub>;
  ASSETS?: Fetcher;
  BATON_ENV: BatonEnv;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAILS: string;
  /** e2e のみ（.dev.vars.e2e）。本番には登録しない */
  E2E_TEST_SECRET?: string;
  /** Web Push（10.3。D-101）。鍵はシークレット。未登録なら通知を送らない */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** 通知のまとめの時間（ミリ秒。既定 15 秒。e2e は 1 秒） */
  BATON_PUSH_BATCH_MS?: string;
  /** 会話の区切り: CEO の最後の発言からの時間（ミリ秒。既定 15 分。e2e は 3 秒） */
  BATON_CONVERSATION_BREAK_MS?: string;
};

function numberVar(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function pushBatchMs(env: Pick<Env, "BATON_PUSH_BATCH_MS">, fallback: number): number {
  return numberVar(env.BATON_PUSH_BATCH_MS, fallback);
}

export function conversationBreakMs(env: Pick<Env, "BATON_CONVERSATION_BREAK_MS">, fallback: number): number {
  return numberVar(env.BATON_CONVERSATION_BREAK_MS, fallback);
}
