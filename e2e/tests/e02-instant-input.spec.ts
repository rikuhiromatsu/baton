// E2 開いてすぐ（スケルトン表示中に）入力欄に打てる。デスクトップは自動フォーカス、iPhone はタップでフォーカス（v1 7.4）。
// v2: 入力欄は COO 宛て（aria-label「COO への指示」。13.5・D-71）。React が宛先を付けて引き継ぐ
import { API_PATHS, COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, composer, isTouchProject, skeleton, uniqueMarker } from "../helpers/ui.ts";

test("E2 スケルトン表示中に COO 宛ての入力欄へ打てて、起動後も文字が残る", async ({ page }, testInfo) => {
  // スケルトンが出ている時間を作るため、COO スレッドの発言の取得を遅らせる
  await page.route(
    (url) => url.pathname === API_PATHS.threadMessages(COO_THREAD_ID) || url.pathname === API_PATHS.threads,
    async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 2_500));
      await route.continue();
    },
  );
  await page.goto("/", { waitUntil: "commit" });

  const input = composer(page);
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("aria-label", UI_TEXT_V2.composer.cooAria);
  await expect(skeleton(page)).toBeVisible();

  if (isTouchProject(testInfo)) {
    // iOS はユーザー操作なしにキーボードを出せないので、タップでフォーカスする
    await input.tap();
  }
  await expect(input).toBeFocused();

  const text = `${uniqueMarker("E2", testInfo)} すぐ打てる`;
  await page.keyboard.type(text);
  // 打ち終わった時点でもまだ起動中（スケルトン表示中に打てた）
  await expect(skeleton(page)).toBeVisible();

  await expect(skeleton(page)).toBeHidden({ timeout: 20_000 });
  // React の入力欄が index.html の入力欄の値を引き継ぎ、宛先は COO
  const live = byTestId(page, TESTIDS.composerInput).first();
  await expect(live).toHaveValue(text);
  await expect(live).toHaveAttribute("aria-label", UI_TEXT_V2.composer.cooAria);
  await expect(byTestId(page, TESTIDS.threadTarget)).toContainText(UI_TEXT_V2.roles.coo);
});
