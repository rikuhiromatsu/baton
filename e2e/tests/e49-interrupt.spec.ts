// E49 中断（DESIGN-v2 5.7・13.4・13.7）: ① COO のターン中に入力欄の `中断` → 発言は canceled（本文は残る）。
// ② 動いているメンバーを詳細の `中断` → paused（interrupted）で `再開` が出る → `再開` で続いて確認に届く
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, messageBySeq, onlyOn, uniqueMarker, visibleMessages } from "../helpers/ui.ts";

test("E49 COO の返事とメンバーの作業を中断でき、メンバーは再開できる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(300_000);

  // ───── ① COO のターン ─────
  const marker = uniqueMarker("E49", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  await page.goto("/");
  await api.sayToCoo(`${marker} ${MARK.long} ${MARK.slow} 中断の確認`);
  let seq = -1;
  await expect
    .poll(async () => {
      const hit = (await visibleMessages(page)).find((m) => m.author === "coo" && m.seq > start && m.status === "streaming");
      seq = hit?.seq ?? -1;
      return seq;
    }, { message: "COO が返事を書いている", timeout: RUNNER_TIMEOUT, intervals: [100, 200] })
    .toBeGreaterThan(-1);
  // 偽 claude の [long] は先に道具を十数回呼んでから長い文章を書く（15.2）。文章が流れ始めてから中断する（本文が残ることを見るため）
  await expect(messageBySeq(page, seq)).toContainText("長い返事の段落です", { timeout: RUNNER_TIMEOUT });
  const interrupt = byTestId(page, TESTIDS.interruptButton).first();
  await expect(interrupt).toBeVisible();
  await interrupt.click();
  await expect(messageBySeq(page, seq)).toHaveAttribute("data-status", "canceled", { timeout: 20_000 });
  const stored = (await api.messages(COO_THREAD_ID)).find((m) => m.seq === seq);
  expect(stored?.status).toBe("canceled");
  expect(stored?.body.length ?? 0, "本文は残る").toBeGreaterThan(0);
  await expect.poll(async () => (await api.cooThread()).status, { timeout: 20_000 }).not.toBe("running");

  // ───── ② メンバー ─────
  const marker2 = uniqueMarker("E49m", testInfo);
  const created = await api.createInstructionViaChat(marker2, `${MARK.slow} メンバーを止める確認`);
  const d = await api.waitForDetail(created.id, (x) => x.sessions.some((s) => s.role === "member" && s.status === "running"), "メンバーが動いている");
  const member = d.sessions.find((s) => s.role === "member" && s.status === "running")!;
  await page.goto(`/i/${created.id}?s=${member.id}`);
  await page.locator(`[data-testid="${TESTIDS.sessionTab}"][data-session-id="${member.id}"]`).click();
  await byTestId(page, TESTIDS.interruptButton).first().click();
  await api.waitForDetail(
    created.id,
    (x) => x.sessions.find((s) => s.id === member.id)?.status === "paused",
    "メンバーが paused（interrupted）になる",
    20_000,
  );
  const resume = byTestId(page, TESTIDS.resumeButton).first();
  await expect(resume).toBeVisible();
  await resume.click();
  await api.waitForDetail(created.id, (x) => x.sessions.find((s) => s.id === member.id)?.status !== "paused", "再開する", 20_000);
  await api.waitForStatus(created.id, "review", RUNNER_TIMEOUT);
});
