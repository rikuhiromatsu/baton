// E14 縦スクロール中にカードが横に動かない（斜めの指の動き。設計書 7.6 の向きの判定と touch-action: pan-y）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, swipeCard } from "../helpers/swipe.ts";
import { byTestId, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E14 縦向きに近い斜めの指の動きではカードが横に動かず、状態も変わらない", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneChromium]);
  const marker = uniqueMarker("E14", testInfo);
  const { instruction } = await api.createAndWait(`${marker} 縦スクロールの確認`);

  await page.goto("/");
  const card = cardById(page, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");
  await card.scrollIntoViewIfNeeded();

  // カードとその中の要素の左端（横に動いたらどれかがずれる。縦スクロールでは変わらない）
  const lefts = () =>
    card.evaluate((el) => [el, ...Array.from(el.querySelectorAll("*")).slice(0, 40)].map((e) => e.getBoundingClientRect().left));
  const initial = await lefts();
  let maxShift = 0;
  const box = await card.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 844;
  // 画面の中に収まる向きに 220px 縦に動かしつつ、横にも 30px 動かす（|dx| < |dy| × 1.5 なので縦スクロール扱い）
  const dy = (box?.y ?? 0) + 260 < viewportHeight ? 220 : -220;

  await swipeCard(page, card, "right", {
    distance: 30,
    dy,
    durationMs: 400,
    onStep: async () => {
      const now = await lefts();
      for (const [i, left] of now.entries()) maxShift = Math.max(maxShift, Math.abs(left - (initial[i] ?? left)));
    },
  });

  expect(maxShift, "指の動きの途中でカードが横に動かない").toBeLessThan(4);
  await expectStable(() => card.getAttribute("data-status"), 1_000, "状態が変わらない");
  await expect(byTestId(page, TESTIDS.undoToast)).toBeHidden();
  expect(await api.status(instruction.id)).toBe("review");
});
