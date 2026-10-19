// E18 初回の案内（D-38・D-69）: 最初のログインで出て、次へで進み、はじめるで閉じる。2 回目は出ない。メニューの「使い方」で開き直せる。
// v2 は 5 ステップ（13.14 の ONBOARDING_STEPS）で、最後は「通知を受け取る」。iOS の Safari のタブ（ホーム画面に追加していない）では
// スイッチの代わりに案内の 1 行が出る（10.4）
import { ONBOARDING_STEPS, TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, press } from "../helpers/ui.ts";

test.use({ showOnboarding: true });

test("E18 初回だけ 5 ステップの案内が出て、最後まで進めると閉じ、メニューから開き直せる", async ({ page }, testInfo) => {
  expect(ONBOARDING_STEPS).toHaveLength(5);
  await page.goto("/");
  const dialog = byTestId(page, TESTIDS.onboarding);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(ONBOARDING_STEPS[0]!.title);
  // 開いている間は裏の入力欄にキーボードが届かない（フォーカスは案内の中）
  await expect(byTestId(page, TESTIDS.onboardingNext)).toBeFocused();
  await page.keyboard.type("x");
  await expect(byTestId(page, TESTIDS.composerInput).first()).toHaveValue("");

  for (let i = 1; i < ONBOARDING_STEPS.length; i++) {
    await press(byTestId(page, TESTIDS.onboardingNext), testInfo);
    await expect(dialog).toHaveAttribute("data-step", String(i));
    await expect(dialog).toContainText(ONBOARDING_STEPS[i]!.title);
    await expect(dialog).toContainText(ONBOARDING_STEPS[i]!.body.slice(0, 12));
  }
  // 最後のステップ（通知を受け取る）: iOS の Safari のタブでは案内の 1 行、それ以外は許可を求めるスイッチ・ボタン
  if (testInfo.project.name === PROJECTS.iphoneWebkit) {
    await expect(byTestId(dialog, TESTIDS.pushIosHint)).toBeVisible();
    await expect(byTestId(dialog, TESTIDS.pushToggle)).toHaveCount(0);
  } else {
    await expect(byTestId(dialog, TESTIDS.pushToggle)).toBeVisible();
  }

  await press(byTestId(page, TESTIDS.onboardingBack), testInfo);
  await expect(dialog).toHaveAttribute("data-step", String(ONBOARDING_STEPS.length - 2));
  await press(byTestId(page, TESTIDS.onboardingNext), testInfo);
  await press(byTestId(page, TESTIDS.onboardingNext), testInfo); // 最後は「はじめる」
  await expect(dialog).toBeHidden();

  // 2 回目は出ない
  await page.reload();
  await expect(byTestId(page, TESTIDS.composerInput).first()).toBeVisible();
  await expect(dialog).toBeHidden();

  // メニューの「使い方」で開き直す。スキップで閉じる
  await press(byTestId(page, TESTIDS.menuButton), testInfo);
  await press(byTestId(page, TESTIDS.menuGuide), testInfo);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-step", "0");
  await press(byTestId(page, TESTIDS.onboardingSkip), testInfo);
  await expect(dialog).toBeHidden();
});
