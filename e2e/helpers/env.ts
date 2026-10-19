// E2E 全体で使う定数（設計書 8.3・D-31）
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "..");

export const BASE_URL = process.env.BATON_E2E_BASE_URL ?? "http://localhost:8790";
/** app/.dev.vars.e2e.example と同じ値。CI でも同じ値を使う */
export const TEST_SECRET = process.env.E2E_TEST_SECRET ?? "e2e-local-secret";
export const CEO_EMAIL = "ceo@example.com";

/** git 管理外（.gitignore の e2e/.auth/） */
export const AUTH_DIR = path.join(E2E_DIR, ".auth");
export const AUTH_FILE = path.join(AUTH_DIR, "ceo.json");
/** ランナーのトークン・PID・ログの置き場所 */
export const RUNNER_STATE_FILE = path.join(AUTH_DIR, "runner.json");

export const RUNNER_LOCAL_PORT = 7778;
export const RUNNER_NAME = "e2e";

export const PROJECTS = {
  desktop: "desktop-chromium",
  iphoneChromium: "iphone-chromium",
  iphoneWebkit: "iphone-webkit",
} as const;
export type ProjectName = (typeof PROJECTS)[keyof typeof PROJECTS];
export const ALL_PROJECTS: readonly ProjectName[] = Object.values(PROJECTS);

/** ランナーの処理を待つときの上限（[slow] で 1 応答 1.5 秒 × 十数回を見込む） */
export const RUNNER_TIMEOUT = 90_000;
