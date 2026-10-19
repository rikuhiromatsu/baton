// E50 サブスク枠（DESIGN-v2 9 章・D-55）: [quota] で偽 claude が rate_limit_event（rejected、resetsAt は 5 秒後）と
// 「You've hit your session limit」を返す → リングが赤（data-status=rejected）、入力欄の上に「枠切れ・…に戻る」の帯、
// COO スレッドに notice、メンバーは枠待ち → 期限を過ぎると自動で続き、確認に届く
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E50 枠切れで止まって知らせが出て、戻ったら自動で続く", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(300_000);
  const marker = uniqueMarker("E50", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  await page.goto("/");
  // [quota] は COO の最初のターンで枠切れになる（9.2: スレッドは not_before 付きで queued、notice）。
  // 指示は枠が戻って COO のターンが続いてからできるので、ここでは話しかけるだけにして、指示はあとで探す
  await api.sayToCoo(`${marker} ${MARK.quota} 枠の確認`);

  // 枠切れ: リングが赤、帯、COO スレッドの notice、メンバーかスレッドが枠待ち
  const ring = byTestId(page, TESTIDS.usageRing).first();
  await expect(ring).toHaveAttribute("data-status", "rejected", { timeout: RUNNER_TIMEOUT });
  await expect(page.getByText(UI_TEXT_V2.transcript.quotaHit).first()).toBeVisible();
  await expect(page.getByText(UI_TEXT_V2.quota.resetsAt).first()).toBeVisible();
  const q = await api.quota();
  expect(q.status).toBe("rejected");
  expect(q.blockedUntil ?? 0).toBeGreaterThan(Date.now() - 60_000);
  await api.waitForMessage(COO_THREAD_ID, { kind: "notice", text: UI_TEXT_V2.transcript.quotaHit, afterSeq: start, status: null }, 30_000);

  // 期限を過ぎると自動で続く（resetsAt + E2E の余裕 0 秒）
  const created = await api.findByMarker(marker);
  await api.waitForStatus(created.id, "review", RUNNER_TIMEOUT + 30_000);
  await expect.poll(async () => (await api.quota()).status, { timeout: 30_000 }).not.toBe("rejected");
  await expect(ring).not.toHaveAttribute("data-status", "rejected");
});
