// E54 サイドパネル（デスクトップ。DESIGN-v2 13.3・D-70〜D-72）: ≥ 1280px は常時表示（264px）。一番上に COO、
// 進行中のプロジェクトの行（件数のチップ・吹き出し）。プロジェクトを選ぶと /p/:id（会話は COO のまま、カードが絞られ、
// 入力欄に `<名前> について` のチップ）。チップの × で外れる。COO で / に戻る。⌘\ でレール（64px）
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById } from "../helpers/swipe.ts";
import { byTestId, cardsPanel, onlyOn, sendFromComposer, sidebarItem, uniqueMarker } from "../helpers/ui.ts";

test("E54 デスクトップのサイドパネルでプロジェクトを選び、COO 宛てのままプロジェクトについて話せる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E54", testInfo);
  // 実行中の指示を 1 つ作る（[slow] で実行中を長く）
  const running = await api.createInstructionViaChat(marker, `${MARK.slow} サイドパネルの確認`);
  await api.waitForStatus(running.id, "running");
  const projectId = running.projectId!;

  await page.goto("/");
  const sidebar = byTestId(page, TESTIDS.sidebar).first();
  await expect(sidebar).toBeVisible();
  const width = (await sidebar.boundingBox())!.width;
  expect(width, "常時表示は 264px").toBeGreaterThanOrEqual(240);
  expect(width).toBeLessThanOrEqual(290);

  // 並び: COO が一番上
  const coo = byTestId(sidebar, TESTIDS.sidebarCoo);
  await expect(coo).toBeVisible();
  const item = sidebarItem(sidebar, projectId);
  await expect(item).toBeVisible();
  expect((await coo.boundingBox())!.y).toBeLessThan((await item.boundingBox())!.y);
  // 件数のチップ（実行中）。0 は出さない
  await expect(item.locator(`[data-testid="${TESTIDS.sidebarCount}"][data-kind="running"]`)).toBeVisible({ timeout: RUNNER_TIMEOUT });
  for (const chip of await item.locator(`[data-testid="${TESTIDS.sidebarCount}"]`).all()) await expect(chip).not.toHaveText(/^0$/);

  // プロジェクトを選ぶ → /p/:id、会話は COO のまま、カードが絞られ、チップ
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}(?:[?#]|$)`));
  await expect(item).toHaveAttribute("data-active", "true");
  await expect(byTestId(page, TESTIDS.thread).first()).toHaveAttribute("data-kind", "coo");
  await expect(byTestId(page, TESTIDS.composerInput).first()).toHaveAttribute("aria-label", UI_TEXT_V2.composer.cooAria);
  const chip = byTestId(page, TESTIDS.contextChip);
  await expect(chip).toContainText(UI_TEXT_V2.conversation.about);
  await expect(chip).toContainText(running.projectName ?? "");
  const panel = await cardsPanel(page, testInfo);
  await expect(cardById(panel, running.id)).toBeVisible();
  const others = (await api.list()).filter((i) => i.projectId !== projectId);
  for (const o of others.slice(0, 5)) await expect(cardById(panel, o.id)).toHaveCount(0);

  // チップ付きで送ると、発言に contextProjectId が付く（宛先は COO）
  const start = await api.lastSeq(COO_THREAD_ID);
  const text = `${marker} このプロジェクトの様子は？`;
  await sendFromComposer(page, text, testInfo);
  const sent = await api.waitForMessage(COO_THREAD_ID, { authorKind: "ceo", text, afterSeq: start, status: null }, 15_000);
  expect(sent.ref.contextProjectId).toBe(projectId);

  // 再読み込みしても選択が残る（URL が正本）。× でチップを外せる
  await page.reload();
  await expect(sidebarItem(byTestId(page, TESTIDS.sidebar).first(), projectId)).toHaveAttribute("data-active", "true");
  await byTestId(page, TESTIDS.contextChipClear).click();
  await expect(byTestId(page, TESTIDS.contextChip)).toHaveCount(0);

  // COO を押すと / に戻る
  await byTestId(page, TESTIDS.sidebarCoo).click();
  await expect(page).toHaveURL(/\/(?:[?#]|$)/);

  // ⌘\ でレール（64px）に、もう一度で戻る
  await page.keyboard.press("Meta+Backslash");
  await expect.poll(async () => (await byTestId(page, TESTIDS.sidebar).first().boundingBox())?.width ?? 0).toBeLessThan(100);
  await page.keyboard.press("Meta+Backslash");
  await expect.poll(async () => (await byTestId(page, TESTIDS.sidebar).first().boundingBox())?.width ?? 0).toBeGreaterThan(200);

  await api.waitForStatus(running.id, "review", RUNNER_TIMEOUT);
});
