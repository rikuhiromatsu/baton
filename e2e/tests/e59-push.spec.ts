// E59 通知（Web Push。DESIGN-v2 10 章・D-81・D-88・D-89）。偽のプッシュサービス（localhost:8799）で受けて復号する。
// - desktop: 設定の `通知` を入れる（PushManager.subscribe を差し替え）→ 購読が保存される。画面が見えている間は COO の発言でも届かない。
//   画面を隠す（visibilitychange → presence: false）と COO の発言から 1 通だけ届き、url が `/`、tag が thread-coo、復号できる。
//   承認はまとめずにすぐ届き、url は /i/:id。
// - iphone-webkit: Safari のタブ（ホーム画面に追加していない）ではスイッチの代わりに案内の 1 行（10.4）
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { E2E_TIMINGS, MARK, PROJECTS, PUSH_SERVICE_ORIGIN, RUNNER_TIMEOUT, SCENARIO_A } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { createTestSubscription, installPushStub, startFakePushService } from "../helpers/push-service.ts";
import { byTestId, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";
import type { Page } from "@playwright/test";

/** 画面を隠した状態にする（visibilitychange と blur。アプリは WebSocket で presence: false を送る。10.2） */
async function hidePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.hasFocus = () => false;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("blur"));
  });
}

test("E59 iOS の Safari のタブでは通知のスイッチの代わりに案内が出る", async ({ page }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneWebkit]);
  await page.goto("/settings");
  await expect(byTestId(page, TESTIDS.settings)).toBeVisible();
  await expect(byTestId(page, TESTIDS.pushIosHint)).toBeVisible();
  await expect(byTestId(page, TESTIDS.pushIosHint)).toContainText(UI_TEXT_V2.settings.iosHint);
  await expect(byTestId(page, TESTIDS.pushToggle)).toHaveCount(0);
});

test("E59 通知を入れると、画面を隠している間の COO の発言と承認が偽のプッシュサービスに届く", async ({ page, context, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(300_000);
  const service = await startFakePushService();
  const sub = createTestSubscription("e59");
  service.register(sub);
  let subscriptionId: string | null = null;
  try {
    await context.grantPermissions(["notifications"]);
    await installPushStub(context, sub);

    // ───── 設定で通知を入れる → 購読が保存される ─────
    await page.goto("/settings");
    const toggle = byTestId(page, TESTIDS.pushToggle);
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect
      .poll(async () => (await api.pushSubscriptions()).find((s) => s.host === new URL(PUSH_SERVICE_ORIGIN).host || s.host === "localhost")?.id ?? null, {
        message: "購読が保存される",
        timeout: 15_000,
      })
      .not.toBeNull();
    subscriptionId = (await api.pushSubscriptions()).find((s) => s.enabled)!.id;
    await expect(byTestId(page, TESTIDS.pushDevice).first()).toBeVisible();

    // ───── 見えている間は届かない ─────
    await page.goto("/");
    await page.bringToFront();
    await expect(byTestId(page, TESTIDS.thread).first()).toBeVisible();
    let start = await api.lastSeq(COO_THREAD_ID);
    await api.sayToCoo(`${MARK.scenarioA} ${SCENARIO_A.ceo1}`);
    await api.waitForMessage(COO_THREAD_ID, { authorKind: "coo", text: SCENARIO_A.coo1, afterSeq: start });
    await expectStable(async () => service.forSubscription(sub.id).length, E2E_TIMINGS.pushBatchMs + 3_000, "画面が見えている間は届かない");
    expect(service.forSubscription(sub.id)).toHaveLength(0);

    // ───── 隠すと、COO の発言が 1 通だけ届く（まとめて 1 秒） ─────
    await hidePage(page);
    await page.waitForTimeout(500); // presence が Hub に届くまで
    start = await api.lastSeq(COO_THREAD_ID);
    await api.sayToCoo(`${MARK.scenarioA} ${SCENARIO_A.ceo1}`);
    const reply = await api.waitForMessage(COO_THREAD_ID, { authorKind: "coo", text: SCENARIO_A.coo1, afterSeq: start });
    await expect.poll(() => service.forSubscription(sub.id).length, { message: "通知が届く", timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    await expectStable(async () => service.forSubscription(sub.id).length, E2E_TIMINGS.pushBatchMs + 2_000, "まとめて 1 通だけ");
    const [first] = service.forSubscription(sub.id);
    expect(first!.error, `復号できる（${first!.error}）`).toBeNull();
    expect(first!.payload).toMatchObject({ title: "COO", url: "/", tag: COO_THREAD_ID });
    expect(first!.payload!.body).toContain(SCENARIO_A.coo1);
    expect(first!.payload!.unread).toBeGreaterThan(0);
    expect(reply.notify).toBe(true);
    // ヘッダ（10.3）: aes128gcm・TTL・VAPID（aud は送り先のオリジン、exp は 24 時間以内）
    expect(first!.headers["content-encoding"]).toBe("aes128gcm");
    expect(Number(first!.headers.ttl)).toBeGreaterThan(0);
    expect(first!.vapid.k, "VAPID の公開鍵").toBeTruthy();
    expect(first!.vapid.jwtClaims?.aud).toBe(PUSH_SERVICE_ORIGIN);
    expect(Number(first!.vapid.jwtClaims?.exp ?? 0) * 1000).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);
    expect(first!.bodyBytes).toBeLessThanOrEqual(4096);

    // ───── 承認はまとめずにすぐ届く（url は /i/:id） ─────
    const marker = uniqueMarker("E59", testInfo);
    const created = await api.createInstructionViaChat(marker, `${MARK.approve} パッケージを足して`);
    const decision = await api.waitForOpenDecision(created.id, undefined, RUNNER_TIMEOUT);
    const decidedAt = Date.now();
    await expect
      .poll(() => service.forSubscription(sub.id).find((r) => r.payload?.url.startsWith(`/i/${created.id}`)) ?? null, {
        message: "承認の通知が届く",
        timeout: 10_000,
      })
      .not.toBeNull();
    const approvalPush = service.forSubscription(sub.id).find((r) => r.payload?.url.startsWith(`/i/${created.id}`))!;
    expect(approvalPush.at - decidedAt, "承認はすぐ（まとめない）").toBeLessThan(8_000);
    expect(approvalPush.headers.urgency).toBe("high");
    if (decision.sessionId) expect(approvalPush.payload!.url).toContain(`s=${decision.sessionId}`);
    await api.answerDecision(decision.id, { verdict: "allow" }).catch(() => {
      // 時間切れで interrupted に変わっていたら、そちらに答える
    });
  } finally {
    if (subscriptionId) await api.deletePushSubscription(subscriptionId).catch(() => {});
    await service.close();
  }
});
