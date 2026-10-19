// E2E 全体で使う定数（v1 設計書 8.3・D-31、DESIGN-v2 15.3）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUSH_E2E_ALLOWED_ORIGIN } from "@baton/shared";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "..");

export const BASE_URL = process.env.BATON_E2E_BASE_URL ?? "http://localhost:8790";
/** app/.dev.vars.e2e.example と同じ値。CI でも同じ値を使う */
export const TEST_SECRET = process.env.E2E_TEST_SECRET ?? "e2e-local-secret";
export const CEO_EMAIL = "ceo@example.com";

/** git 管理外（.gitignore の e2e/.auth/） */
export const AUTH_DIR = path.join(E2E_DIR, ".auth");
export const AUTH_FILE = path.join(AUTH_DIR, "ceo.json");
/** ランナーのトークン・PID・ログ・作業フォルダの場所 */
export const RUNNER_STATE_FILE = path.join(AUTH_DIR, "runner.json");

export const RUNNER_LOCAL_PORT = 7778;
export const RUNNER_NAME = "e2e";

/**
 * ランナーに渡す claude の実行ファイル（15.1・15.2）。E2E では常に偽 claude。
 * BATON_CLAUDE_BIN が偽 claude 以外を指していたら起動しない（global-setup が検査する）
 */
export const FAKE_CLAUDE_BIN = path.join(REPO_ROOT, "tools/fake-claude/bin/claude");

/** 偽のプッシュサービス（10.5）。Worker の e2e 環境だけがこのオリジンへの送信を許す */
export const PUSH_SERVICE_ORIGIN = PUSH_E2E_ALLOWED_ORIGIN;
export const PUSH_SERVICE_PORT = Number(new URL(PUSH_E2E_ALLOWED_ORIGIN).port);

/**
 * E2E 用に短くした時間（15.3）。ランナーと偽 claude に環境変数で渡す。
 * 通知のまとめ（1 秒）は Worker の e2e の vars（app/wrangler.jsonc の env.e2e）で入れる
 */
export const E2E_TIMINGS = {
  /** BATON_APPROVAL_WAIT_MS: 承認のプロセス内の待ち（本番 10 分） */
  approvalWaitMs: 3_000,
  /** BATON_THREAD_IDLE_MS: スレッドのプロセスを result のあと生かす時間（本番 120 秒） */
  threadIdleMs: 2_000,
  /** FAKE_QUOTA_RESET_SEC: [quota] の resetsAt（今から何秒後） */
  fakeQuotaResetSec: 5,
  /** BATON_CONVERSATION_BREAK_MS: 会話の区切り（本番 15 分） */
  conversationBreakMs: 3_000,
  /** BATON_QUOTA_RESUME_MARGIN_MS: resetsAt に足す余裕（本番 60 秒） */
  quotaResumeMarginMs: 0,
  /** 通知のまとめ（Worker の e2e。本番 15 秒） */
  pushBatchMs: 1_000,
} as const;

/** 承認から確定までの時間（D-66。E2E でも本番と同じ 20 秒） */
export const FINALIZE_DELAY_MS = 20_000;

export const PROJECTS = {
  desktop: "desktop-chromium",
  iphoneChromium: "iphone-chromium",
  iphoneWebkit: "iphone-webkit",
} as const;
export type ProjectName = (typeof PROJECTS)[keyof typeof PROJECTS];
export const ALL_PROJECTS: readonly ProjectName[] = Object.values(PROJECTS);

/** ランナーの処理を待つときの上限（[slow] で 1 応答 1.5 秒 × COO・リーダー・メンバー・リーダー・COO を見込む） */
export const RUNNER_TIMEOUT = 90_000;
/** シナリオ A のように何周も回るものの上限 */
export const SCENARIO_TIMEOUT = 150_000;

/** 偽 claude の台本のマーカー（15.2）。本文に入れて台本を選ぶ */
export const MARK = {
  scenarioA: "[scenario-a]",
  propose: "[propose]",
  repo: "[repo]",
  ask: "[ask]",
  approve: "[approve]",
  deny: "[deny]",
  conflict: "[conflict]",
  quota: "[quota]",
  warn: "[warn]",
  slow: "[slow]",
  fail: "[fail]",
  maxturns: "[maxturns]",
  badjson: "[badjson]",
  long: "[long]",
} as const;

/** シナリオ A の台本の文（15.2 の表・14.1）。偽 claude と同じ文 */
export const SCENARIO_A = {
  ceo1: "ショート動画の台本 10 本作りたい",
  coo1: "なんの動画ですか？",
  ceo2: "コーヒー紹介のやつです。題材は提案して。",
  coo2: "わかりました、ではチームリーダーに依頼します。",
  projectName: "ショート動画台本",
  projectSlug: "shorts",
  leader1: "了解です。リサーチと執筆で進めます",
  coo3: "チームリーダーから 10 本の案が上がって来ました。",
  ceo3: "方向性がちょっと違うかも。もっとニッチなやつがいい",
  leader2: "わかりました。リサーチメンバーに参考を集めさせます",
  ceo4: "たすかる！",
  coo4: "ニッチ寄りに組み直した 10 本です。",
} as const;
