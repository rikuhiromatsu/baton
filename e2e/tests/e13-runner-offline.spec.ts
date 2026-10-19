// E13 ランナーを止める → ランナーの点が灰色 → COO に話しかけても返事が無く指示もできない → ランナー再起動で処理される（v1 1.5）。
// ランナーは全テストで共有なので、止めている時間は短くし、失敗しても必ず起動し直す。
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { isRunnerRunning, startRunner, stopRunner } from "../helpers/runner.ts";
import { byTestId, cardInPanel, expectMessageOnScreen, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E13 ランナーが止まっている間は COO が返事をせず、再起動すると処理される", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E13", testInfo);

  await page.goto("/");
  const dot = byTestId(page, TESTIDS.runnerDot);
  await expect(dot).toHaveAttribute("data-online", "true", { timeout: 30_000 });

  try {
    await stopRunner();
    // ランナーの WebSocket が閉じると、DO が即座に offline を配る
    await expect(dot).toHaveAttribute("data-online", "false", { timeout: 20_000 });

    const start = await api.lastSeq(COO_THREAD_ID);
    const input = byTestId(page, TESTIDS.composerInput);
    await input.fill(`${marker} ランナー停止中の依頼`);
    await byTestId(page, TESTIDS.composerSend).click();
    await expectMessageOnScreen(page, { author: "ceo", text: marker, afterSeq: start, status: null }, 15_000);
    await expectStable(
      async () => ({
        coo: (await api.findMessages(COO_THREAD_ID, { authorKind: "coo", afterSeq: start, status: null })).length,
        instructions: (await api.list()).filter((i) => i.body.includes(marker)).length,
      }),
      4_000,
      "ランナーが止まっている間は COO の返事も指示も無い",
    );
    expect((await api.cooThread()).status).toBe("queued");

    startRunner();
    await expect(dot).toHaveAttribute("data-online", "true", { timeout: 30_000 });
    await expectMessageOnScreen(page, { author: "coo", afterSeq: start }, RUNNER_TIMEOUT);
    const created = await api.findByMarker(marker);
    await expect(await cardInPanel(page, testInfo, created.id)).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
  } finally {
    if (!isRunnerRunning()) startRunner();
  }
});
