// E17 横幅 390px で横スクロールが出ない、入力欄が safe-area の上にある（設計書 7.4・7.10）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById } from "../helpers/swipe.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E17 iPhone の幅で横にはみ出さず、入力欄が safe-area より上にある", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneWebkit]);
  // 区切りの無い長い本文のカードがあっても、横にはみ出さないこと
  const marker = uniqueMarker("E17", testInfo);
  const created = await api.createInstruction(`${marker}${"x".repeat(240)}`);

  await page.goto("/");
  const input = byTestId(page, TESTIDS.composerInput);
  await expect(input).toBeVisible();
  await expect(cardById(page, created.id)).toBeVisible();

  const layout = () =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:0;padding-bottom:env(safe-area-inset-bottom, 0px)";
      document.body.appendChild(probe);
      const safeBottom = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      probe.remove();
      window.scrollTo(200, window.scrollY);
      const scrollX = window.scrollX;
      window.scrollTo(0, window.scrollY);
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        docWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        scrollX,
        safeBottom,
      };
    });

  const check = async () => {
    const l = await layout();
    expect(l.innerWidth).toBe(390);
    expect(l.docWidth, "文書の横幅が画面幅を超えない").toBeLessThanOrEqual(l.innerWidth);
    expect(l.bodyWidth, "body の横幅が画面幅を超えない").toBeLessThanOrEqual(l.innerWidth);
    expect(l.scrollX, "横にスクロールできない").toBe(0);

    for (const target of [input, byTestId(page, TESTIDS.composerSend)]) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(l.innerWidth);
      expect(box!.y + box!.height, "safe-area より上").toBeLessThanOrEqual(l.innerHeight - l.safeBottom);
    }
  };

  await check();
  // 長い文字列を打っても横に広がらない
  await input.tap();
  await input.fill(`${"あ".repeat(120)}${"y".repeat(200)}`);
  await check();
});
