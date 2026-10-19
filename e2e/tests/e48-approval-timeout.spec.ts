// E48 承認の時間切れ（DESIGN-v2 7.6・D-45）: 承認を 3 秒（E2E の BATON_APPROVAL_WAIT_MS）放っておく → メンバーに拒否して中断、
// 指示は判断待ち（needs_decision、判断は interrupted）→ 後から `許可` → 1 回限りの許可で --resume して続き、確認に届く
import { TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { E2E_TIMINGS, MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { flick } from "../helpers/swipe.ts";
import { byTestId, cardInPanel, onlyOn, press, uniqueMarker } from "../helpers/ui.ts";

test("E48 承認が時間切れになると判断待ちに落ち、あとで許可すると続く", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E48", testInfo);
  const created = await api.createInstructionViaChat(marker, `${MARK.approve} パッケージを足して`);
  const approval = await api.waitForOpenDecision(created.id, "approval");

  // 待ちの 3 秒を過ぎると判断待ちに落ちる（他に動いているものが無いので指示も needs_decision）
  const d = await api.waitForStatus(created.id, "needs_decision", E2E_TIMINGS.approvalWaitMs + 30_000);
  const interrupted = d.openDecisions.find((x) => x.kind === "interrupted");
  expect(interrupted, "時間切れの判断（interrupted）が開いている").toBeTruthy();
  const member = d.sessions.find((s) => s.id === approval.sessionId);
  expect(member?.status, "メンバーは止まっている").toMatch(/^(paused|idle|done|canceled|failed)$/);

  // カードは判断待ち → 右フリックで判断シート → 許可
  await page.goto("/");
  const card = await cardInPanel(page, testInfo, created.id);
  await expect(card).toHaveAttribute("data-status", "needs_decision");
  await flick(page, card, "right");
  const allow = byTestId(page, TESTIDS.approvalAllow).first();
  await expect(allow).toBeVisible();
  await press(allow, testInfo);

  // 判断待ち → 実行中 → 確認。メンバーのトランスクリプトに「再開」
  await api.waitForStatus(created.id, ["running", "review"], 15_000);
  await api.waitForStatus(created.id, "review", RUNNER_TIMEOUT);
  await expect
    .poll(async () => (await api.transcript(approval.sessionId!)).some((i) => i.kind === "system" && i.summary.includes(UI_TEXT_V2.transcript.resume)), {
      message: "メンバーのトランスクリプトに「再開」",
      timeout: 15_000,
    })
    .toBe(true);
});
