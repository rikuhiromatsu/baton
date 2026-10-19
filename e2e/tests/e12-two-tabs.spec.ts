// E12 2 つのタブで開き、片方の操作がもう片方に即座に反映される（WebSocket。設計書 4.5）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E12 片方のタブの操作と送信が、もう片方に再読み込みなしで反映される", async ({ page, context, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E12", testInfo);
  const { instruction } = await api.createAndWait(`${marker} 2 タブの確認`);

  const other = await context.newPage();
  await page.goto("/");
  await other.goto("/");
  const cardA = cardById(page, instruction.id);
  const cardB = cardById(other, instruction.id);
  await expect(cardA).toHaveAttribute("data-status", "review");
  await expect(cardB).toHaveAttribute("data-status", "review");

  // A で承認 → B に反映
  await page.bringToFront();
  await flick(page, cardA, "right");
  await expect(cardA).toHaveAttribute("data-status", "done");
  await expect(cardB).toHaveAttribute("data-status", "done");

  // A で新しい指示を送る → B に現れる
  const marker2 = uniqueMarker("E12n", testInfo);
  const input = byTestId(page, TESTIDS.composerInput);
  await input.fill(`${marker2} もう片方のタブへ`);
  await byTestId(page, TESTIDS.composerSend).click();
  const created = await api.findByMarker(marker2);
  await expect(cardById(other, created.id)).toBeVisible();

  await other.close();
});
