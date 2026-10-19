// E2E の前準備（v1 設計書 8.3、DESIGN-v2 15.3）。webServer（app の e2e:serve）が起動したあとに動く。
// 1. テスト用ログインで Cookie を作り storageState に保存
// 2. 前回の実行の残り（手元で起動済みのサーバーを使い回したとき、ローカルの D1 に残る）を片付ける
// 3. ランナーのトークンを発行し、作業フォルダと sample-repo を一時フォルダに作り、
//    偽 claude（BATON_CLAUDE_BIN）を渡したランナーを子プロセスとして起動して、オンラインかつ claude の点が「ok」になるまで待つ
import fs from "node:fs";
import type { FullConfig } from "@playwright/test";
import type { InstructionStatus } from "@baton/shared";
import { BatonApi } from "./helpers/api.ts";
import { AUTH_DIR, AUTH_FILE, BASE_URL } from "./helpers/env.ts";
import { issueRunnerToken, loginAsCeo } from "./helpers/login.ts";
import { initRunnerState, isRunnerRunning, readRunnerState, resolveClaudeBin, runnerLogTail, startRunner, stopRunner } from "./helpers/runner.ts";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // 本物の claude を指していないか、偽 claude があるかを最初に確かめる（D-60）
  resolveClaudeBin();
  // 前回の実行で残ったランナーがいれば止め（7778 番を空ける）、その一時フォルダも消す
  const previous = readRunnerState();
  await stopRunner();
  if (previous?.rootDir && !process.env.BATON_E2E_KEEP_DATA) fs.rmSync(previous.rootDir, { recursive: true, force: true });
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
    await waitForRunnerReady(api);
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
 * ローカルの D1 は（手元でサーバーを使い回すと）実行をまたいで残るので、前回までの指示をすべてアーカイブへ片付ける。
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

/** ランナーがオンラインになり、claude（偽物）の `auth status` が通って claudeAuth が ok になるまで待つ（7.7・13.12） */
async function waitForRunnerReady(api: BatonApi): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last = "";
  while (Date.now() < deadline) {
    const s = await api.session();
    last = `online=${s.runner.online} claudeAuth=${s.runner.claudeAuth} claudeVersion=${s.runner.claudeVersion}`;
    if (s.runner.online && s.runner.claudeAuth === "ok") return;
    if (!isRunnerRunning()) throw new Error(`ランナーが起動直後に終了しました。ランナーのログ:\n${runnerLogTail()}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`ランナーが 45 秒以内に使える状態になりませんでした（${last}）。ランナーのログ:\n${runnerLogTail()}`);
}
