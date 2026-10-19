// E2E の前準備（設計書 8.3）。webServer（app の e2e:serve）が起動したあとに動く。
// 1. テスト用ログインで Cookie を作り storageState に保存
// 2. 前回の実行の残り（ローカルの D1 に残る）を片付ける
// 3. ランナーのトークンを発行し、ランナーを子プロセスとして起動して、オンラインになるまで待つ
import fs from "node:fs";
import type { FullConfig } from "@playwright/test";
import { BatonApi } from "./helpers/api.ts";
import { AUTH_DIR, AUTH_FILE, BASE_URL } from "./helpers/env.ts";
import { issueRunnerToken, loginAsCeo } from "./helpers/login.ts";
import { initRunnerState, isRunnerRunning, runnerLogTail, startRunner, stopRunner } from "./helpers/runner.ts";
import type { InstructionStatus } from "@baton/shared";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // 前回の実行で残ったランナーがいれば止める（7778 番を空ける）
  await stopRunner();
  await waitForServerReady();

  const ctx = await loginAsCeo();
  try {
    await ctx.storageState({ path: AUTH_FILE });
    const api = new BatonApi(ctx);
    await api.session();

    await cleanUpLeftovers(api);

    const { token, runnerId } = await issueRunnerToken(ctx);
    initRunnerState(token, runnerId);
    startRunner();
    await waitForRunnerOnline(api);
  } finally {
    await ctx.dispose();
  }
}

/**
 * webServer は URL が開いた時点で「起動した」とみなすが、CI の直後は vite preview から workerd への接続が
 * まだ不安定で 500（fetch failed）を返すことがある。/api/health が 3 回続けて 200 になるまで待つ
 */
async function waitForServerReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  while (Date.now() < deadline) {
    const ok = await fetch(`${BASE_URL}/api/health`).then((r) => r.ok).catch(() => false);
    streak = ok ? streak + 1 : 0;
    if (streak >= 3) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("サーバーが 60 秒以内に安定して応答しませんでした（/api/health）");
}

/**
 * ローカルの D1 は実行をまたいで残るので、前回までの指示をすべてアーカイブへ片付ける。
 * 一覧は 1 ページ 50 件で、完了も 7 日は出るため、残しておくと新しいカードが一覧の外に押し出されうる。
 */
async function cleanUpLeftovers(api: BatonApi): Promise<void> {
  const steps: Partial<Record<InstructionStatus, "cancel" | "approve" | "archive">> = {
    queued: "cancel",
    running: "cancel",
    needs_decision: "cancel",
    review: "approve",
    done: "archive",
    failed: "archive",
    canceled: "archive",
  };
  let moved = 0;
  for (let round = 0; round < 3; round++) {
    const items = await api.list("active");
    if (items.length === 0) break;
    for (const item of items) {
      const action = steps[item.status];
      if (!action) continue;
      try {
        await api.transition(item.id, action, item.status);
        moved++;
      } catch (e) {
        // 片付けは補助なので、競合（ランナーが同時に動かした等）は次の周回に回す
        console.warn(`[e2e] 片付けに失敗（${item.id} ${item.status} → ${action}）: ${(e as Error).message}`);
      }
    }
  }
  if (moved > 0) console.log(`[e2e] 前回の指示を片付けた: ${moved} 件の操作`);
}

async function waitForRunnerOnline(api: BatonApi): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = await api.session();
    if (s.runner.online) return;
    if (!isRunnerRunning()) throw new Error(`ランナーが起動直後に終了しました。ランナーのログ:\n${runnerLogTail()}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`ランナーが 30 秒以内にオンラインになりませんでした。ランナーのログ:\n${runnerLogTail()}`);
}
