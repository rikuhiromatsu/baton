// E13 ランナーを止める → ランナーの点が灰色 → 指示を送っても待機のまま → ランナー再起動で処理される（設計書 1.5）
// ランナーは全テストで共有なので、止めている時間は短くし、失敗しても必ず起動し直す。
import { TESTIDS } from "@baton/shared";
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { isRunnerRunning, startRunner, stopRunner } from "../helpers/runner.ts";
import { cardById } from "../helpers/swipe.ts";
import { byTestId, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E13 ランナーが止まっている間は待機のまま、再起動すると処理される", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E13", testInfo);

  await page.goto("/");
  const dot = byTestId(page, TESTIDS.runnerDot);
  await expect(dot).toHaveAttribute("data-online", "true", { timeout: 30_000 });

  try {
    await stopRunner();
    // ランナーの WebSocket が閉じると、DO が即座に offline を配る
    await expect(dot).toHaveAttribute("data-online", "false", { timeout: 20_000 });

    const input = byTestId(page, TESTIDS.composerInput);
    await input.fill(`${marker} ランナー停止中の指示`);
    await byTestId(page, TESTIDS.composerSend).click();
    const created = await api.findByMarker(marker);
    const card = cardById(page, created.id);
    await expect(card).toHaveAttribute("data-status", "queued");
    await expectStable(() => card.getAttribute("data-status"), 4_000, "ランナーが止まっている間は待機のまま");
    expect(await api.status(created.id)).toBe("queued");

    startRunner();
    await expect(dot).toHaveAttribute("data-online", "true", { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
  } finally {
    if (!isRunnerRunning()) startRunner();
  }
});
