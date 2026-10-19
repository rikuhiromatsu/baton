// Worker のバインディングと変数（設計書 9.3・9.6）
import type { BatonEnv } from "@baton/shared";
import type { BatonHub } from "./hub/batonhub.ts";

export type Env = {
  DB: D1Database;
  HUB: DurableObjectNamespace<BatonHub>;
  /** e2e 環境には無い（ScriptedAiClient を使う） */
  AI?: Ai;
  ASSETS?: Fetcher;
  BATON_ENV: BatonEnv;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAILS: string;
  /** e2e のみ（.dev.vars.e2e）。本番には登録しない */
  E2E_TEST_SECRET?: string;
  MODEL_COO?: string;
  MODEL_LEADER?: string;
  MODEL_MEMBER?: string;
  MODEL_UTIL?: string;
};
