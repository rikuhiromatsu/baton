// E44 降りていく・戻る（DESIGN-v2 4.6・13.3・13.13）: 3 通りの入口（COO の発言のカードの `リーダーと話す`、
// サイドパネルのリーダーの吹き出し、組織図のリーダーのノード）でリーダーのスレッドへ。`← COO に戻る` で戻る。
// モバイルは左端からのスワイプでも戻る
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { edgeSwipe } from "../helpers/swipe.ts";
import { byTestId, isTouchProject, messageBySeq, onlyOn, openSidebar, press, revealOrgNode, sidebarItem, uniqueMarker } from "../helpers/ui.ts";
import type { Page, TestInfo } from "@playwright/test";

async function expectInLeaderThread(page: Page, projectId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}/leader(?:[?#]|$)`));
  await expect(byTestId(page, TESTIDS.thread).first()).toHaveAttribute("data-kind", "leader");
  await expect(byTestId(page, TESTIDS.backToCoo)).toBeVisible();
  await expect(page.getByText(UI_TEXT_V2.conversation.reportedToCoo)).toBeVisible();
  // 宛先はリーダー（入力欄の aria-label と宛先の表示）
  await expect(byTestId(page, TESTIDS.composerInput).first()).toHaveAttribute("aria-label", UI_TEXT_V2.composer.leaderAria);
  await expect(byTestId(page, TESTIDS.threadTarget)).toContainText(UI_TEXT_V2.roles.leader);
}

async function backToCoo(page: Page, testInfo: TestInfo, how: "button" | "edge"): Promise<void> {
  if (how === "edge") await edgeSwipe(page);
  else await press(byTestId(page, TESTIDS.backToCoo), testInfo);
  await expect(page).toHaveURL(/\/(?:[?#]|$)/);
  await expect(byTestId(page, TESTIDS.thread).first()).toHaveAttribute("data-kind", "coo");
  await expect(byTestId(page, TESTIDS.composerInput).first()).toHaveAttribute("aria-label", UI_TEXT_V2.composer.cooAria);
}

test("E44 3 通りの入口からリーダーのスレッドへ降り、COO に戻れる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop, PROJECTS.iphoneChromium]);
  const marker = uniqueMarker("E44", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  const { instruction } = await api.createAndWait(marker, "降りていく確認");
  const projectId = instruction.projectId!;
  const report = await api.waitForMessage(COO_THREAD_ID, { authorKind: "coo", kind: "report", instructionId: instruction.id, afterSeq: start });

  // ① COO の発言のカードの `リーダーと話す`
  await page.goto("/");
  const bubble = messageBySeq(page, report.seq);
  await bubble.scrollIntoViewIfNeeded();
  await press(bubble.locator(`[data-testid="${TESTIDS.leaderLink}"]`).first(), testInfo);
  await expectInLeaderThread(page, projectId);
  await backToCoo(page, testInfo, "button");

  // ② サイドパネルのプロジェクトの吹き出し（モバイルはドロワー）
  const sidebar = await openSidebar(page, testInfo);
  await press(sidebarItem(sidebar, projectId).locator(`[data-testid="${TESTIDS.sidebarLeaderLink}"]`), testInfo);
  await expectInLeaderThread(page, projectId);
  // モバイルは左端スワイプで戻る（リーダーのスレッドでは左端スワイプは「COO に戻る」。13.3）
  await backToCoo(page, testInfo, isTouchProject(testInfo) ? "edge" : "button");

  // ③ 組織図のリーダーのノード
  await page.goto("/org");
  const org = await api.org();
  const leaderAgent = org.projects.find((p) => p.project.id === projectId)?.leader?.agent;
  expect(leaderAgent, "組織図にこのプロジェクトのリーダーがいる").toBeTruthy();
  await press(await revealOrgNode(page, testInfo, leaderAgent!.id, instruction.projectName ?? ""), testInfo);
  await expectInLeaderThread(page, projectId);
  await backToCoo(page, testInfo, "button");
});
