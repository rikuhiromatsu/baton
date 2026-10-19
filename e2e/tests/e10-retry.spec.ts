// E10 [fail] → 失敗 → 右フリックで再実行（設計書 3.5・8.2.1）
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E10 失敗した指示を右フリックで再実行できる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E10", testInfo);
  // [slow] で再実行中の状態を観測できるようにする。[fail] なので再実行もまた失敗する
  const first = await api.createAndWait(`${marker} [fail] [slow] 失敗する指示`, "failed");
  expect(first.instruction.error).toBeTruthy();
  const attemptBefore = first.instruction.attempt;

  await page.goto("/");
  const card = cardById(page, first.instruction.id);
  await expect(card).toHaveAttribute("data-status", "failed");

  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", /^(queued|running)$/);

  await expect(card).toHaveAttribute("data-status", "failed", { timeout: RUNNER_TIMEOUT });
  const again = await api.waitForStatus(first.instruction.id, "failed", 10_000);
  expect(again.instruction.attempt, "再実行で claim し直された").toBeGreaterThan(attemptBefore);
});
