// E3 全画面スケルトンが出て、データがそろうと消える（COO スレッドの発言を 800ms 遅らせて確認。v1 7.9・13.12）
import { API_PATHS, COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, composer, onlyOn, skeleton } from "../helpers/ui.ts";

test("E3 会話の取得中は全画面スケルトン、そろったら消える", async ({ page }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);

  const isMessages = (url: URL) => url.pathname === API_PATHS.threadMessages(COO_THREAD_ID);
  let respondedAt = 0;
  page.on("response", (res) => {
    if (isMessages(new URL(res.url())) && res.request().method() === "GET" && respondedAt === 0) respondedAt = Date.now();
  });
  await page.route(isMessages, async (route) => {
    if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });

  await page.goto("/");
  await expect(skeleton(page)).toBeVisible();
  // 入力欄はスケルトンにしない（起動中もずっと本物）
  await expect(composer(page)).toBeVisible();

  await expect(skeleton(page)).toBeHidden({ timeout: 10_000 });
  expect(respondedAt, "スケルトンは発言の応答が来てから消える").toBeGreaterThan(0);
  await expect(byTestId(page, TESTIDS.thread).first()).toBeAttached();
  // ≥ 1280px はサイドパネルと指示カードの列も出る（13.4）
  await expect(byTestId(page, TESTIDS.sidebar).first()).toBeVisible();
  await expect(byTestId(page, TESTIDS.cardsPanel).first()).toBeVisible();
  await expect(byTestId(page, TESTIDS.composerInput)).toBeVisible();
});
