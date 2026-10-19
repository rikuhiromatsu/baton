// E2E の設定（設計書 8.3、D-28、D-31）
// - webServer: app を e2e モードでビルドし、ローカルの D1 にマイグレーションを当てて 8790 番で配信する
// - globalSetup: テスト用ログイン → storageState、ランナーのトークン発行 → ランナーを子プロセスで起動
// - globalTeardown: ランナーを止める
import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE, BASE_URL, E2E_DIR, PROJECTS, REPO_ROOT } from "./helpers/env.ts";

const CI = !!process.env.CI;

// app/.dev.vars.e2e が無ければ example から作る（E2E_TEST_SECRET などが入る。git 管理外）。
// webServer は globalSetup より先に起動するので、ここで用意する。何度呼んでも同じ結果になる。
const devVars = path.join(REPO_ROOT, "app/.dev.vars.e2e");
if (!fs.existsSync(devVars)) fs.copyFileSync(path.join(REPO_ROOT, "app/.dev.vars.e2e.example"), devVars);

const iphone = {
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: devices["iPhone 15"].userAgent,
};

export default defineConfig({
  testDir: path.join(E2E_DIR, "tests"),
  outputDir: path.join(E2E_DIR, "test-results"),
  globalSetup: path.join(E2E_DIR, "global-setup.ts"),
  globalTeardown: path.join(E2E_DIR, "global-teardown.ts"),

  // ランナーは 1 つ（同時実行 2）を全テストで共有するので、並列は控えめにする
  workers: CI ? 2 : 3,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // ランナーの処理（[slow] は 1 応答 1.5 秒）を待つテストがあるので長め
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: CI
    ? [["list"], ["html", { open: "never", outputFolder: path.join(E2E_DIR, "playwright-report") }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: path.join(E2E_DIR, "playwright-report") }]],

  use: {
    baseURL: BASE_URL,
    storageState: AUTH_FILE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    serviceWorkers: "allow",
  },

  projects: [
    {
      name: PROJECTS.desktop,
      use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: PROJECTS.iphoneChromium,
      use: { ...iphone, browserName: "chromium" },
    },
    {
      name: PROJECTS.iphoneWebkit,
      use: { ...iphone, browserName: "webkit" },
    },
  ],

  webServer: {
    // e2e:serve = e2e モードのビルド → ローカル D1 のマイグレーション → vite preview --port 8790
    command: "npm run e2e:serve -w app",
    cwd: REPO_ROOT,
    url: `${BASE_URL}/api/health`,
    // CI では必ず新しく起動する。手元では起動済みのサーバーがあれば使う
    reuseExistingServer: !CI,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
