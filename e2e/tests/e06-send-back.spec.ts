// E6 確認を左フリック → 差し戻しシート → コメント送信 → 待機 → 再実行されて確認（設計書 3.5）
import { TESTIDS } from "@baton/shared";
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { byTestId, onlyOn, trackedStatuses, trackStatuses, uniqueMarker } from "../helpers/ui.ts";

test("E6 左フリックで差し戻し、コメント付きで再実行されて確認に戻る", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneChromium]);
  const marker = uniqueMarker("E6", testInfo);
  // [slow] で再実行に時間をかけ、確認から離れたことを観測できるようにする
  const { instruction } = await api.createAndWait(`${marker} [slow] 差し戻しの確認`);

  await page.goto("/");
  const card = cardById(page, instruction.id);
  await expect(card).toHaveAttribute("data-status", "review");
  await trackStatuses(page, instruction.id);

  await flick(page, card, "left");
  const input = byTestId(page, TESTIDS.sendbackInput);
  await expect(input).toBeVisible();
  // シートを開くときはカードを元に戻す（状態はまだ変わらない）
  await expect(card).toHaveAttribute("data-status", "review");

  const comment = `${marker} 根拠の出典を足して`;
  await input.tap();
  await input.fill(comment);
  await byTestId(page, TESTIDS.sendbackSubmit).tap();
  await expect(input).toBeHidden();

  await expect(card).toHaveAttribute("data-status", /^(queued|running)$/);
  const detail = await api.detail(instruction.id);
  expect(detail.instruction.feedback).toBe(comment);

  await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
  const seen = await trackedStatuses(page, instruction.id);
  expect(seen[0]).toBe("review");
  expect(seen.slice(1), `状態の移り変わり: ${seen.join(" → ")}`).toContain("running");
  expect(seen[seen.length - 1]).toBe("review");
});
