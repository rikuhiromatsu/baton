// E10 [fail] → 失敗 → 右フリックで再実行（v1 3.5。v2 は COO スレッドに notice・COO のターン。4.4）
import { COO_THREAD_ID } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { flick } from "../helpers/swipe.ts";
import { cardInPanel, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E10 失敗した指示を右フリックで再実行できる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E10", testInfo);
  // [slow] で再実行中の状態を観測できるようにする。[fail@member] なのでメンバーだけが失敗し（COO・リーダーは動く）、再実行もまた失敗する
  const first = await api.createAndWait(marker, `${MARK.failMember} ${MARK.slow} 失敗する指示`, "failed");
  expect(first.instruction.error).toBeTruthy();
  const attemptBefore = first.instruction.attempt;
  const cooStart = await api.lastSeq(COO_THREAD_ID);

  await page.goto("/");
  const card = await cardInPanel(page, testInfo, first.instruction.id);
  await expect(card).toHaveAttribute("data-status", "failed");

  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", /^(queued|running)$/);
  await api.waitForMessage(COO_THREAD_ID, { kind: "notice", instructionId: first.instruction.id, afterSeq: cooStart, status: null }, 15_000);

  await expect(card).toHaveAttribute("data-status", "failed", { timeout: RUNNER_TIMEOUT });
  const again = await api.waitForStatus(first.instruction.id, "failed", 10_000);
  expect(again.instruction.attempt, "再実行で claim し直された").toBeGreaterThan(attemptBefore);
});
