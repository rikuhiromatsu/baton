// E16 PWA: マニフェストが取れる、Service Worker が登録される、オフラインでも / が開き入力欄が出る（設計書 7.10）
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { composer, onlyOn } from "../helpers/ui.ts";

test("E16 マニフェストと Service Worker があり、オフラインでも入力欄が出る", async ({ page, context }, testInfo) => {
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

  await context.setOffline(true);
  try {
    await page.goto("/");
    await expect(composer(page)).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
