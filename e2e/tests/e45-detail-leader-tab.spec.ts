// E45 指示の詳細のリーダーのタブからの発言が、リーダーのスレッドにも出る（DESIGN-v2 4.4・13.7・D-54）
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, expectMessageOnScreen, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E45 詳細のリーダーのタブから送った発言が、指示のカード付きでリーダーのスレッドに入る", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E45", testInfo);
  const { instruction } = await api.createAndWait(marker, "詳細から話す確認");
  const leader = await api.leaderThread(instruction.projectId!);
  const start = await api.lastSeq(leader.id);

  await page.goto(`/i/${instruction.id}`);
  const tab = page.locator(`[data-testid="${TESTIDS.sessionTab}"][data-role="leader"]`);
  await expect(tab).toBeVisible();
  await tab.click();
  // リーダーのタブの入力欄はスレッドへの発言（aria-label「リーダーへの発言」）
  const input = byTestId(page, TESTIDS.followupInput).or(byTestId(page, TESTIDS.composerInput)).filter({ visible: true }).first();
  await expect(input).toHaveAttribute("aria-label", "リーダーへの発言");
  const text = `${marker} 詳細のタブから一言`;
  await input.fill(text);
  await byTestId(page, TESTIDS.followupSend).or(byTestId(page, TESTIDS.composerSend)).filter({ visible: true }).first().click();

  const sent = await api.waitForMessage(leader.id, { authorKind: "ceo", text, afterSeq: start, status: null }, 15_000);
  expect(sent.instructionId, "指示のカード付き").toBe(instruction.id);

  // リーダーのスレッドを開くと同じ発言が見える
  await page.goto(`/p/${instruction.projectId}/leader`);
  const seq = await expectMessageOnScreen(page, { author: "ceo", text, afterSeq: start, status: null });
  expect(seq).toBe(sent.seq);
  await expect(page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${seq}"] [data-testid="${TESTIDS.messageInstructionCard}"]`)).toBeVisible();
});
