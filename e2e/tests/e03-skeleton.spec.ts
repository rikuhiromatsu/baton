// E3 全画面スケルトンが出て、データがそろうと消える（/api/instructions を 800ms 遅らせて確認。設計書 7.9）
import { expect, test } from "@playwright/test";
import { API_PATHS, TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { byTestId, composer, onlyOn, skeleton } from "../helpers/ui.ts";

test("E3 一覧の取得中は全画面スケルトン、そろったら消える", async ({ page }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);

  const isList = (url: URL) => url.pathname === API_PATHS.instructions;
  let listRespondedAt = 0;
  page.on("response", (res) => {
    if (isList(new URL(res.url())) && res.request().method() === "GET" && listRespondedAt === 0) listRespondedAt = Date.now();
  });
  await page.route(isList, async (route) => {
    if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });

  await page.goto("/");
  await expect(skeleton(page)).toBeVisible();
  // 入力欄はスケルトンにしない（起動中もずっと本物）
  await expect(composer(page)).toBeVisible();

  await expect(skeleton(page)).toBeHidden({ timeout: 10_000 });
  expect(listRespondedAt, "スケルトンは一覧の応答が来てから消える").toBeGreaterThan(0);
  await expect(byTestId(page, TESTIDS.instructionList)).toBeAttached();
  await expect(byTestId(page, TESTIDS.composerInput)).toBeVisible();
});
