// E15 reduced-motion をエミュレートしても全操作が完了する（設計書 7.7）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test.use({ reducedMotion: "reduce" });

test("E15 動きを減らす設定でも、送信・フリック・取り消し・詳細の開閉ができる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E15", testInfo);
  const { instruction } = await api.createAndWait(`${marker} 動きを減らす設定`);

  await page.goto("/");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  const card = cardById(page, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");

  // 承認 → 取り消し → もう一度承認
  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", "done");
  await byTestId(page, TESTIDS.undoButton).click();
  await expect(card).toHaveAttribute("data-status", "review");
  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", "done");
  await api.waitForStatus(instruction.id, "done", 10_000);

  // 詳細シートの開閉
  await card.click();
  const sheet = byTestId(page, TESTIDS.instructionSheet);
  await expect(sheet).toBeVisible();
  await byTestId(page, TESTIDS.sheetClose).click();
  await expect(sheet).toBeHidden();

  // 送信
  const marker2 = uniqueMarker("E15n", testInfo);
  await byTestId(page, TESTIDS.composerInput).fill(`${marker2} 動きを減らした送信`);
  await byTestId(page, TESTIDS.composerSend).click();
  const created = await api.findByMarker(marker2);
  await expect(cardById(page, created.id)).toBeVisible();
});
