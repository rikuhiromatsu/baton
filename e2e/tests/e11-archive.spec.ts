// E11 完了を右フリック → アーカイブ画面に移る → 右フリックで戻る（設計書 3.5・7.2）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E11 完了をアーカイブし、アーカイブ画面から戻せる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E11", testInfo);
  const { instruction } = await api.createAndWait(`${marker} アーカイブの確認`);
  await api.transition(instruction.id, "approve", "review");

  await page.goto("/");
  const card = cardById(page, instruction.id);
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(byTestId(page, TESTIDS.instructionGroup("done")).locator(`[data-id="${instruction.id}"]`)).toBeVisible();

  await flick(page, card, "right");
  await expect(card).toHaveCount(0);
  await api.waitForStatus(instruction.id, "archived", 10_000);

  await byTestId(page, TESTIDS.menuButton).click();
  await byTestId(page, TESTIDS.menuArchive).click();
  await expect(page).toHaveURL(/\/archive(?:[?#]|$)/);
  const list = byTestId(page, TESTIDS.archiveList);
  await expect(list).toBeVisible();
  const archived = list.locator(`[data-testid="${TESTIDS.instructionCard}"][data-id="${instruction.id}"]`);
  await expect(archived).toHaveAttribute("data-status", "archived");

  await flick(page, archived, "right");
  await expect(archived).toHaveCount(0);
  await api.waitForStatus(instruction.id, "done", 10_000);

  await page.goto("/");
  await expect(cardById(page, instruction.id)).toHaveAttribute("data-status", "done");
});
