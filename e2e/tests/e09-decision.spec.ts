// E9 [ask] の指示 → 判断待ちが一番上に紫で出る → 右フリックで判断シート → 選択肢で回答 → 処理が続いて確認（設計書 5.7・3.5）
import { TESTIDS } from "@baton/shared";
import { RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { cardById, flick } from "../helpers/swipe.ts";
import { byTestId, press, uniqueMarker } from "../helpers/ui.ts";

/** --accent-decision（#AF52DE）。ふちの色に使われていること */
const DECISION_RGB = "175, 82, 222";

test("E9 判断待ちに選択肢で答えると処理が続いて確認になる", async ({ page, api }, testInfo) => {
  const marker = uniqueMarker("E9", testInfo);
  const created = await api.createInstruction(`${marker} [ask] 方針を決めて進めて`);
  await api.waitForStatus(created.id, "needs_decision");

  await page.goto("/");
  const card = cardById(page, created.id);
  await expect(card).toHaveAttribute("data-status", "needs_decision");

  // 一覧の一番上のまとまりが判断待ちで、カードはその中にある
  const groups = byTestId(page, TESTIDS.instructionList).locator('[data-testid^="instruction-group-"]');
  await expect(groups.first()).toHaveAttribute("data-testid", TESTIDS.instructionGroup("needs_decision"));
  await expect(byTestId(page, TESTIDS.instructionGroup("needs_decision")).locator(`[data-id="${created.id}"]`)).toBeVisible();

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

  // 右フリックは判断シートを開く（状態は変えない）
  await flick(page, card, "right");
  const panel = byTestId(page, TESTIDS.decisionPanel);
  await expect(panel).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "needs_decision");

  // ScriptedAiClient の選択肢は A案・B案（8.2.1）。選択肢のボタンを押すとその文で回答する
  const option = byTestId(panel, TESTIDS.decisionOption(0));
  await expect(option).toContainText("A案");
  await press(option, testInfo);

  const answered = await api.waitForStatus(created.id, ["queued", "running", "review"], 15_000);
  const decision = answered.decisions.find((d) => d.instructionId === created.id);
  expect(decision?.status).toBe("answered");
  expect(decision?.answer ?? "").toContain("A案");

  await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
  await api.waitForStatus(created.id, "review", 10_000);
});
