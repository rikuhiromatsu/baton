// E46 メンバーへの追加の依頼（DESIGN-v2 5.6・13.7・D-54）: 詳細のメンバーのタブの入力欄（`追加の依頼`）から送ると、
// 動いていれば標準入力、止まっていれば --resume で届き、トランスクリプトに CEO の発言と偽 claude の
// 「追加の依頼を受けました: …」が出る（15.2）
import { TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E46 メンバーのタブから追加の依頼を送ると、そのメンバーに届いてトランスクリプトに出る", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E46", testInfo);
  const created = await api.createInstructionViaChat(marker, `${MARK.slow} 追加の依頼の確認`);
  const d = await api.waitForDetail(created.id, (x) => x.sessions.some((s) => s.role === "member"), "メンバーのセッションが始まる");
  const member = d.sessions.find((s) => s.role === "member")!;

  await page.goto(`/i/${created.id}?s=${member.id}`);
  const tab = page.locator(`[data-testid="${TESTIDS.sessionTab}"][data-session-id="${member.id}"]`);
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute("data-role", "member");
  await tab.click();
  await expect(byTestId(page, TESTIDS.transcript)).toBeVisible();

  const input = byTestId(page, TESTIDS.followupInput);
  await expect(input).toHaveAttribute("aria-label", UI_TEXT_V2.composer.followupAria);
  const text = `${marker} 見出しも付けて`;
  await input.fill(text);
  await byTestId(page, TESTIDS.followupSend).click();

  // トランスクリプトに CEO の発言（右寄せ）と、偽 claude の受け取り
  await expect(page.locator(`[data-testid="${TESTIDS.transcriptItem}"][data-kind="user"]`, { hasText: text })).toBeVisible({ timeout: RUNNER_TIMEOUT });
  await expect
    .poll(async () => (await api.transcript(member.id)).some((i) => JSON.stringify(i.body).includes(`追加の依頼を受けました: ${text}`)), {
      message: "メンバーが追加の依頼を受け取った",
      timeout: RUNNER_TIMEOUT,
    })
    .toBe(true);
  await expect(page.locator(`[data-testid="${TESTIDS.transcriptItem}"]`, { hasText: "追加の依頼を受けました" }).first()).toBeVisible();
});
