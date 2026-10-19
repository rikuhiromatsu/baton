// E7 待機・実行中（[slow]）を左フリック → 取消。ランナーが止まる（以降タスクが増えない）（設計書 3.5・5.9）
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E7 処理中の指示を左フリックで取り消すと、ランナーがそれ以上進めない", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E7", testInfo);
  const created = await api.createInstruction(`${marker} [slow] 取り消す指示`);

  await page.goto("/");
  const card = cardById(page, created.id);
  // ランナーはすぐ claim するので、待機のままフリックすると expectedStatus が食い違って 409 になりうる。
  // [slow] で実行中が十数秒続くので、実行中になったのを見てからフリックする（取消は待機・実行中のどちらからでも同じ）
  await expect(card).toHaveAttribute("data-status", "running", { timeout: RUNNER_TIMEOUT });

  await flick(page, card, "left");
  await expect(card).toHaveAttribute("data-status", "canceled");
  await api.waitForStatus(created.id, "canceled", 10_000);

  // 取消のあと、タスクもログも増えない（ランナーが処理を打ち切った）
  await expectStable(
    async () => {
      const d = await api.detail(created.id);
      return { status: d.instruction.status, tasks: d.tasks.length, lastEventSeq: d.lastEventSeq };
    },
    6_000,
    "取消のあとにタスクやログが増えない",
  );
  await expect(card).toHaveAttribute("data-status", "canceled");
});
