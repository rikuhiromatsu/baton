// E8 短い・遅いフリック（しきい値未満）は戻り、状態が変わらない。速いフリック（距離 50px・速度大）は確定（v1 7.6・D-24）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { swipeCard } from "../helpers/swipe.ts";
import { byTestId, cardInPanel, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E8 しきい値未満のフリックは戻り、50px の速いフリックは確定する", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneChromium, PROJECTS.iphoneWebkit]);
  const marker = uniqueMarker("E8", testInfo);
  const { instruction } = await api.createAndWait(marker, "しきい値の確認");

  await page.goto("/");
  const card = await cardInPanel(page, testInfo, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");
  const before = await card.boundingBox();

  // 短く遅い: 60px を 600ms（約 100px/s）。しきい値 min(120px, 幅×0.32) にも 800px/s にも届かない
  await swipeCard(page, card, "right", { distance: 60, durationMs: 600 });
  await expectStable(() => card.getAttribute("data-status"), 1_500, "しきい値未満では状態が変わらない");
  await expect(card).toHaveAttribute("data-status", "review");
  await expect(byTestId(page, TESTIDS.undoToast)).toBeHidden();
  const after = await card.boundingBox();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0)), "カードが元の位置に戻る").toBeLessThan(2);
  expect(await api.status(instruction.id)).toBe("review");

  // 速い: 50px を 1 回の動きで（headless Chromium はタッチを 40〜60ms おきにしか届けないため、分けると 800px/s に届かない）。
  // 距離 40px 以上かつ 800px/s 以上で確定する
  await swipeCard(page, card, "right", { distance: 50, durationMs: 32, moves: 2 });
  await expect(card).toHaveAttribute("data-status", "done");
  await api.waitForStatus(instruction.id, "done", 10_000);
});
