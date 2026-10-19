// E2 開いてすぐ（スケルトン表示中に）入力欄に打てる。デスクトップは自動フォーカス、iPhone はタップでフォーカス（設計書 7.4）
import { expect, test } from "../helpers/fixtures.ts";
import { API_PATHS, TESTIDS } from "@baton/shared";
import { byTestId, composer, isTouchProject, skeleton, uniqueMarker } from "../helpers/ui.ts";

test("E2 スケルトン表示中に入力欄へ打てて、起動後も文字が残る", async ({ page }, testInfo) => {
  // スケルトンが出ている時間を作るため、一覧の取得を遅らせる
  await page.route(
    (url) => url.pathname === API_PATHS.instructions,
    async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 2_500));
      await route.continue();
    },
  );
  await page.goto("/", { waitUntil: "commit" });

  const input = composer(page);
  await expect(input).toBeVisible();
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
  // React の入力欄が index.html の入力欄の値を引き継いでいる
  await expect(byTestId(page, TESTIDS.composerInput)).toHaveValue(text);
});
