// E17 横幅 390px で横スクロールが出ない、入力欄が safe-area の上にある（v1 7.4・7.10、DESIGN-v2 13.13）。
// 画面ごとの横スクロールは E57 で全画面を見る。ここは会話の画面で、長い発言・長い入力でもはみ出さないこと
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, expectMessageOnScreen, expectNoHorizontalScroll, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E17 iPhone の幅で横にはみ出さず、入力欄が safe-area より上にある", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneWebkit]);
  // 区切りの無い長い本文の発言（とそこから生まれるカード）があっても、横にはみ出さないこと
  const marker = uniqueMarker("E17", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  await api.sayToCoo(`${marker}${"x".repeat(240)}`);

  await page.goto("/");
  const input = byTestId(page, TESTIDS.composerInput);
  await expect(input).toBeVisible();
  await expectMessageOnScreen(page, { author: "ceo", text: marker, afterSeq: start, status: null }, 15_000);

  const safeBottom = () =>
    page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:0;padding-bottom:env(safe-area-inset-bottom, 0px)";
      document.body.appendChild(probe);
      const v = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      probe.remove();
      return { safeBottom: v, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    });

  const check = async () => {
    const l = await safeBottom();
    expect(l.innerWidth).toBe(390);
    await expectNoHorizontalScroll(page, "会話");
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
