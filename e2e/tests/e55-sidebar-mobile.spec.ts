// E55 サイドパネル（モバイル。DESIGN-v2 13.3・13.13・D-72）: < 1024px はドロワー。上部バーのボタンか、画面の左端 16px からの
// 右スワイプで開く。プロジェクトを選ぶと閉じて /p/:id。カードのフリックは 16px より内側で始まるので、ドロワーではなくカードが動く
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { edgeSwipe, flick } from "../helpers/swipe.ts";
import { byTestId, cardInPanel, onlyOn, press, sidebarItem, uniqueMarker } from "../helpers/ui.ts";

test("E55 モバイルのドロワーは左端スワイプとボタンで開き、内側からのフリックはカードが受ける", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneChromium, PROJECTS.iphoneWebkit]);
  const marker = uniqueMarker("E55", testInfo);
  const { instruction } = await api.createAndWait(marker, "ドロワーの確認");
  const projectId = instruction.projectId!;

  await page.goto("/");
  const drawer = byTestId(page, TESTIDS.sidebarDrawer);
  await expect(byTestId(page, TESTIDS.composerInput).first()).toBeVisible();
  await expect(drawer).toBeHidden();

  // ① 左端からの右スワイプで開く
  await edgeSwipe(page);
  await expect(drawer).toBeVisible();
  await expect(byTestId(drawer, TESTIDS.sidebarCoo)).toBeVisible();
  // プロジェクトを選ぶとドロワーが閉じて /p/:id
  await press(sidebarItem(drawer, projectId), testInfo);
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}(?:[?#]|$)`));
  await expect(drawer).toBeHidden();

  // ② 上部バーのボタンで開き、COO を選ぶと閉じて /
  await press(byTestId(page, TESTIDS.sidebarToggle), testInfo);
  await expect(drawer).toBeVisible();
  await press(byTestId(drawer, TESTIDS.sidebarCoo), testInfo);
  await expect(page).toHaveURL(/\/(?:[?#]|$)/);
  await expect(drawer).toBeHidden();

  // ③ `指示` のシートの中で、内側から始めた右フリックはカードが受ける（ドロワーは開かない）
  const card = await cardInPanel(page, testInfo, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");
  const box = (await card.boundingBox())!;
  expect(box.x + 24, "フリックの始点は左端 16px より内側").toBeGreaterThan(16);
  await flick(page, card, "right");
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(drawer).toBeHidden();
  await api.waitForStatus(instruction.id, "done", 10_000);
});
