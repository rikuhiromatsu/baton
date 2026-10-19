// E18 初回の案内（D-38）: 最初のログインで出て、次へで進み、はじめるで閉じる。2 回目は出ない。メニューの「使い方」で開き直せる
import { ONBOARDING_STEPS, TESTIDS } from "@baton/shared";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, press } from "../helpers/ui.ts";

test.use({ showOnboarding: true });

test("E18 初回だけ案内が出て、最後まで進めると閉じ、メニューから開き直せる", async ({ page }, testInfo) => {
  await page.goto("/");
  const dialog = byTestId(page, TESTIDS.onboarding);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(ONBOARDING_STEPS[0]!.title);

  for (let i = 1; i < ONBOARDING_STEPS.length; i++) {
    await press(byTestId(page, TESTIDS.onboardingNext), testInfo);
    await expect(dialog).toHaveAttribute("data-step", String(i));
    await expect(dialog).toContainText(ONBOARDING_STEPS[i]!.title);
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
