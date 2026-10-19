// E47 承認（DESIGN-v2 7.6・13.3・13.7、D-53）: メンバーが許可リスト外の操作（[approve]）を求める → サイドパネルに `承認待ち` →
// 押すと承認カード（/i/:id?s=<session>）→ `許可` で続く。もう 1 件は理由を書いて `拒否` → メンバーに拒否が伝わり続く。
// E2E では承認の待ちが 3 秒（BATON_APPROVAL_WAIT_MS）なので、時間切れのあと（判断待ち）でも同じカードで答えられる
import { TESTIDS } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, onlyOn, openSidebar, press, uniqueMarker } from "../helpers/ui.ts";

test("E47 承認待ちをサイドパネルから開いて許可・拒否できる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop, PROJECTS.iphoneWebkit]);
  test.setTimeout(300_000);

  // ───── 許可 ─────
  const allowMarker = uniqueMarker("E47a", testInfo);
  const toAllow = await api.createInstructionViaChat(allowMarker, `${MARK.approve} パッケージを足して`);
  const decisionA = await api.waitForOpenDecision(toAllow.id);
  expect(decisionA.toolName, "承認は道具の名前付き").toBeTruthy();

  await page.goto("/");
  const sidebar = await openSidebar(page, testInfo);
  const approvals = byTestId(sidebar, TESTIDS.sidebarApprovals);
  await expect(approvals).toBeVisible();
  await press(approvals, testInfo);
  await expect(page).toHaveURL(/\/i\/[^/?#]+/);
  // 承認待ちが複数あり得るので、この指示の承認カードを開く
  await page.goto(`/i/${toAllow.id}${decisionA.sessionId ? `?s=${decisionA.sessionId}` : ""}`);
  const cardA = byTestId(page, TESTIDS.approvalCard).first();
  await expect(cardA).toBeVisible();
  await press(byTestId(cardA, TESTIDS.approvalAllow), testInfo);
  await api.waitForDetail(toAllow.id, (d) => d.decisions.some((x) => x.verdict === "allow" && x.status === "answered"), "許可で答えた", 15_000);
  await api.waitForStatus(toAllow.id, "review", RUNNER_TIMEOUT);

  // ───── 拒否（理由付き） ─────
  const denyMarker = uniqueMarker("E47d", testInfo);
  const toDeny = await api.createInstructionViaChat(denyMarker, `${MARK.approve} もう 1 つ足して`);
  const decisionD = await api.waitForOpenDecision(toDeny.id);
  await page.goto(`/i/${toDeny.id}${decisionD.sessionId ? `?s=${decisionD.sessionId}` : ""}`);
  const cardD = byTestId(page, TESTIDS.approvalCard).first();
  await expect(cardD).toBeVisible();
  const reason = `${denyMarker} 依存は増やさない`;
  const reasonInput = byTestId(cardD, TESTIDS.approvalReason);
  if (!(await reasonInput.isVisible().catch(() => false))) await press(byTestId(cardD, TESTIDS.approvalDeny), testInfo);
  await expect(reasonInput).toBeVisible();
  await reasonInput.fill(reason);
  await press(byTestId(cardD, TESTIDS.approvalDeny), testInfo);
  const denied = await api.waitForDetail(toDeny.id, (d) => d.decisions.some((x) => x.verdict === "deny" && x.status === "answered"), "拒否で答えた", 15_000);
  expect(denied.decisions.find((x) => x.verdict === "deny")?.answer ?? "").toContain("依存は増やさない");
  // 拒否はメンバーに伝わり、処理は続く（許可されなかった操作をせずに終える）。
  // 時間切れ（3 秒）のあとの拒否は「再開しない」扱いもあり得るので、判断待ちのまま残ったら片付ける
  const end = await api.waitForStatus(toDeny.id, ["review", "failed", "needs_decision"], RUNNER_TIMEOUT);
  if (end.instruction.status === "needs_decision") await api.transition(toDeny.id, "cancel", "needs_decision");
  await expect(byTestId(sidebar, TESTIDS.sidebarApprovals)).toHaveCount(0);
});
