// E9 承認の判断待ち（DESIGN-v2 7.6・13.8、D-53）: [approve] の指示でメンバーが許可リスト外の操作を求める →
// 開いた承認のある指示は判断待ちのまとまり（一番上・紫）に出る → 右フリックで判断シート（状態は変えない。フリックだけでは許可しない）
// → `許可` → 処理が続いて確認
import { TESTIDS } from "@baton/shared";
import { MARK, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { flick } from "../helpers/swipe.ts";
import { byTestId, cardInPanel, cardsPanel, press, uniqueMarker } from "../helpers/ui.ts";

/** --accent-decision（ライト #AF52DE）。ふちの色に使われていること */
const DECISION_RGB = "175, 82, 222";

test("E9 承認待ちの指示は判断待ちのまとまりに出て、シートで許可すると続いて確認になる", async ({ page, api }, testInfo) => {
  const marker = uniqueMarker("E9", testInfo);
  const created = await api.createInstructionViaChat(marker, `${MARK.approve} パッケージを足して進めて`);
  const decision = await api.waitForOpenDecision(created.id);

  await page.goto("/");
  const panel = await cardsPanel(page, testInfo);
  const card = await cardInPanel(page, testInfo, created.id);
  // 開いた判断（承認を含む）があれば running でも判断待ちのまとまり（displayGroup）
  await expect(card).toHaveAttribute("data-group", "needs_decision");
  const groups = panel.locator('[data-testid^="instruction-group-"]');
  await expect(groups.first()).toHaveAttribute("data-testid", TESTIDS.instructionGroup("needs_decision"));
  await expect(byTestId(panel, TESTIDS.instructionGroup("needs_decision")).locator(`[data-id="${created.id}"]`)).toBeVisible();

  // 紫のふち（カード自身・疑似要素・子要素のどこかのふちか影に判断の色がある）
  await expect
    .poll(() =>
      card.evaluate((el, rgb) => {
        const props = ["border-top-color", "outline-color", "box-shadow"] as const;
        const els = [el, ...Array.from(el.querySelectorAll("*")).slice(0, 20)];
        return els.some((e) =>
          [null, "::before", "::after"].some((pseudo) => {
            const cs = getComputedStyle(e, pseudo);
            const bordered = parseFloat(cs.borderTopWidth) > 0 || cs.outlineStyle !== "none" || cs.boxShadow !== "none";
            return bordered && props.some((p) => cs.getPropertyValue(p).replace(/\s+/g, " ").includes(rgb));
          }),
        );
      }, DECISION_RGB),
    )
    .toBe(true);

  // 右フリックは判断シートを開く（承認はフリックだけでは許可しない）。
  // E2E の承認の待ちは 3 秒なので、その間に running → needs_decision（時間切れ）に変わることはある。ここでは「許可されていない」ことを見る
  await flick(page, card, "right");
  const allow = byTestId(page, TESTIDS.approvalAllow).first();
  await expect(allow).toBeVisible();
  const d = await api.detail(created.id);
  expect(d.openDecisions.length, "フリックだけでは許可されない（判断が開いたまま）").toBeGreaterThan(0);
  expect(d.decisions.some((x) => x.verdict === "allow"), "フリックだけでは許可されない").toBe(false);
  expect(["running", "needs_decision"]).toContain(d.instruction.status);

  await press(allow, testInfo);
  await api.waitForDetail(
    created.id,
    (x) => x.decisions.some((y) => y.verdict === "allow" && y.status === "answered"),
    `判断 ${decision.id}（またはその時間切れの後継）が許可で答えられる`,
    15_000,
  );
  await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
  await api.waitForStatus(created.id, "review", 10_000);
});
