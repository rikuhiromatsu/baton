// E5 確認のカードを右フリック → 完了。取り消しトーストの「元に戻す」で確認に戻る（設計書 3.5・7.6）
import { TESTIDS } from "@baton/shared";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { byTestId, press, uniqueMarker } from "../helpers/ui.ts";

test("E5 右フリックで承認し、元に戻すで確認に戻る", async ({ page, api }, testInfo) => {
  const marker = uniqueMarker("E5", testInfo);
  const { instruction } = await api.createAndWait(`${marker} 承認と取り消し`);

  await page.goto("/");
  const card = cardById(page, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");

  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", "done");
  const toast = byTestId(page, TESTIDS.undoToast);
  await expect(toast).toBeVisible();

  await press(byTestId(page, TESTIDS.undoButton), testInfo);
  await expect(card).toHaveAttribute("data-status", "review");
  await api.waitForStatus(instruction.id, "review", 10_000);
});
