// E12 2 つのタブで開き、片方の操作がもう片方に即座に反映される（WebSocket。v1 4.5、DESIGN-v2 12.5）。
// v2: カードのフリックに加え、COO への発言と COO の返事（message.upserted）も反映される
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { flick } from "../helpers/swipe.ts";
import { byTestId, cardInPanel, expectMessageOnScreen, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E12 片方のタブの操作と発言が、もう片方に再読み込みなしで反映される", async ({ page, context, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E12", testInfo);
  const { instruction } = await api.createAndWait(marker, "2 タブの確認");

  const other = await context.newPage();
  await page.goto("/");
  await other.goto("/");
  const cardA = await cardInPanel(page, testInfo, instruction.id);
  const cardB = await cardInPanel(other, testInfo, instruction.id);
  await expect(cardA).toHaveAttribute("data-status", "review");
  await expect(cardB).toHaveAttribute("data-status", "review");

  // A で承認 → B に反映
  await page.bringToFront();
  await flick(page, cardA, "right");
  await expect(cardA).toHaveAttribute("data-status", "done");
  await expect(cardB).toHaveAttribute("data-status", "done");

  // A で COO に話しかける → B に CEO の発言と COO の返事、新しいカードが現れる
  const start = await api.lastSeq("thread-coo");
  const marker2 = uniqueMarker("E12n", testInfo);
  const input = byTestId(page, TESTIDS.composerInput);
  await input.fill(`${marker2} もう片方のタブへ`);
  await byTestId(page, TESTIDS.composerSend).click();
  await expectMessageOnScreen(other, { author: "ceo", text: marker2, afterSeq: start, status: null }, 15_000);
  await expectMessageOnScreen(other, { author: "coo", afterSeq: start });
  const created = await api.findByMarker(marker2);
  await expect(await cardInPanel(other, testInfo, created.id)).toBeVisible();

  await other.close();
});
