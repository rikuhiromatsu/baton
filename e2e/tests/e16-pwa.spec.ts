// E16 PWA: マニフェストが取れる、Service Worker が登録される、オフラインでも / が開き入力欄が出る（v1 7.10）。
// v2: オフラインで送った COO への発言は送信待ちになり、つながったら届く（13.5 の outbox）
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, composer, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E16 マニフェストと Service Worker があり、オフラインでも入力欄が出て、送った発言はつながったら届く", async ({ page, context, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);

  const res = await page.request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const manifest = (await res.json()) as { name?: string; start_url?: string; display?: string; icons?: unknown[] };
  expect(manifest.name).toBe("Baton");
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons?.length ?? 0).toBeGreaterThanOrEqual(3);

  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  // Service Worker が有効になり、アプリシェルの precache が済む
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration("/");
          return reg?.active?.state ?? null;
        }),
      { timeout: 30_000 },
    )
    .toBe("activated");

  const marker = uniqueMarker("E16", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  await context.setOffline(true);
  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
    // オフラインのまま送る → 画面には送信中（薄く）で残る
    await expect(byTestId(page, TESTIDS.composerInput).first()).toBeVisible({ timeout: 20_000 });
    await byTestId(page, TESTIDS.composerInput).first().fill(`${marker} オフラインで送った`);
    await byTestId(page, TESTIDS.composerSend).first().click();
    await expect(page.locator(`[data-testid="${TESTIDS.message}"]`, { hasText: marker })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  // つながったら届く（同じ clientId なので 1 回だけ）
  await api.waitForMessage(COO_THREAD_ID, { authorKind: "ceo", text: marker, afterSeq: start, status: null }, 30_000);
  await expect.poll(async () => (await api.findMessages(COO_THREAD_ID, { authorKind: "ceo", text: marker, afterSeq: start, status: null })).length).toBe(1);
});
