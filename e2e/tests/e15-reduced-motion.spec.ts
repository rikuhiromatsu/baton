// E15 reduced-motion をエミュレートしても全操作が完了する（v1 7.7）。v2: 会話の送信・指示の詳細の開閉も
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { flick } from "../helpers/swipe.ts";
import { byTestId, cardInPanel, expectMessageOnScreen, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test.use({ reducedMotion: "reduce" });

test("E15 動きを減らす設定でも、送信・フリック・取り消し・詳細の開閉ができる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E15", testInfo);
  const { instruction } = await api.createAndWait(marker, "動きを減らす設定");

  await page.goto("/");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  const card = await cardInPanel(page, testInfo, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");

  // 承認 → 取り消し → もう一度承認
  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", "done");
  await byTestId(page, TESTIDS.undoButton).click();
  await expect(card).toHaveAttribute("data-status", "review");
  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", "done");
  await api.waitForStatus(instruction.id, "done", 10_000);

  // 詳細の開閉（≥ 1280px は会話の場所に出て `← 会話に戻る`。13.7）
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/i/${instruction.id}`));
  const sheet = byTestId(page, TESTIDS.instructionSheet);
  await expect(sheet).toBeVisible();
  await byTestId(page, TESTIDS.sheetClose).click();
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(/\/i\//);

  // 送信
  const start = await api.lastSeq(COO_THREAD_ID);
  const marker2 = uniqueMarker("E15n", testInfo);
  await byTestId(page, TESTIDS.composerInput).fill(`${marker2} 動きを減らした送信`);
  await byTestId(page, TESTIDS.composerSend).click();
  await expectMessageOnScreen(page, { author: "ceo", text: marker2, afterSeq: start, status: null }, 15_000);
  const created = await api.findByMarker(marker2);
  await expect(await cardInPanel(page, testInfo, created.id)).toBeVisible();
});
