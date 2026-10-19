// E4 指示を送る → カードが待機に出る → ランナーが処理して実行中 → 確認へ自動で動く（WebSocket）。
// 報告・タスクの木・成果物のプレビューが見える（設計書 5.1・7.4・8.2.1）
import { TESTIDS } from "@baton/shared";
import { RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById } from "../helpers/swipe.ts";
import { byTestId, press, trackedStatuses, trackStatuses, uniqueMarker } from "../helpers/ui.ts";

test("E4 送った指示がランナーに処理されて確認まで自動で進み、詳細が見える", async ({ page, api }, testInfo) => {
  const marker = uniqueMarker("E4", testInfo);
  await page.goto("/");

  const input = byTestId(page, TESTIDS.composerInput);
  await expect(input).toBeVisible();
  await press(input, testInfo);
  // [slow] で各段階を 1.5 秒ずつ遅らせ、実行中の状態を確実に観測できるようにする
  await input.fill(`${marker} [slow] 競合を調べてまとめて`);
  await press(byTestId(page, TESTIDS.composerSend), testInfo);
  await expect(input).toHaveValue("");

  const created = await api.findByMarker(marker);
  const card = cardById(page, created.id);
  await expect(card).toBeVisible();
  await trackStatuses(page, created.id);

  // 再読み込みせずに（WebSocket のイベントだけで）確認まで動く
  await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
  const seen = await trackedStatuses(page, created.id);
  expect(["queued", "running"], `最初に見えた状態: ${seen.join(" → ")}`).toContain(seen[0]);
  expect(seen, "実行中を経由した").toContain("running");

  // 詳細シート
  await press(card, testInfo);
  await expect(page).toHaveURL(new RegExp(`/i/${created.id}`));
  const sheet = byTestId(page, TESTIDS.instructionSheet);
  await expect(sheet).toBeVisible();
  await expect(byTestId(sheet, TESTIDS.reportText)).toContainText("テスト報告");

  const tree = byTestId(sheet, TESTIDS.taskTree);
  await expect(tree).toBeVisible();
  const nodes = (kind: string) => tree.locator(`[data-testid="${TESTIDS.taskNode}"][data-kind="${kind}"]`);
  await expect(nodes("plan")).toHaveCount(1);
  await expect(nodes("work")).toHaveCount(2);
  for (const node of await nodes("work").all()) await expect(node).toHaveAttribute("data-status", "done");
  await expect(nodes("review")).toHaveCount(1);

  // メンバー 2 人がそれぞれ notes/t1.md・notes/t2.md を書いて成果物に登録する（8.2.1）
  const artifacts = byTestId(sheet, TESTIDS.artifactItem);
  await expect(artifacts).toHaveCount(2);
  await press(artifacts.first(), testInfo);
  const preview = byTestId(page, TESTIDS.artifactPreview);
  await expect(preview).toBeVisible();
  await expect(preview).not.toBeEmpty();
});
