// E61 ダークモード（DESIGN-v2 13.11・D-92）: colorScheme: "dark" のエミュレーションで主要な画面を開き、
// html の color-scheme が dark、主要な文字（--text-primary）のコントラスト比が 4.5 以上（ページ内で計算）。
// JS を 1 秒遅らせてもスケルトンの段階から地が暗い（インラインのスクリプトと CSS）。設定で `ライト` に固定すると OS がダークでもライト
import { TESTIDS, THEME_STORAGE_KEY } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { groundLuminance, htmlColorScheme, primaryTextContrast } from "../helpers/theme.ts";
import { byTestId, onlyOn, skeleton, uniqueMarker } from "../helpers/ui.ts";

test.use({ colorScheme: "dark" });

test("E61 ダークでは全画面が暗い地で読みやすく、ライトに固定すると OS がダークでもライト", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop, PROJECTS.iphoneWebkit]);
  const marker = uniqueMarker("E61", testInfo);
  const { instruction } = await api.createAndWait(marker, "ダークモードの確認");
  const projectId = instruction.projectId!;

  // ───── スケルトンの段階から暗い（JS を 1 秒遅らせる） ─────
  await page.route(
    (url) => /\.(m?js|tsx?)$/.test(url.pathname) && !url.pathname.startsWith("/api/"),
    async (route) => {
      await new Promise((r) => setTimeout(r, 1_000));
      await route.continue();
    },
  );
  await page.goto("/", { waitUntil: "commit" });
  await expect(skeleton(page)).toBeVisible();
  expect(await htmlColorScheme(page)).toContain("dark");
  expect(await groundLuminance(page), "スケルトンの段階で地が暗い").toBeLessThan(0.05);
  await expect(skeleton(page)).toBeHidden({ timeout: 20_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // ───── 主要な画面 ─────
  const screens: [string, string, string][] = [
    ["/", TESTIDS.thread, "ホーム（COO）"],
    [`/p/${projectId}/leader`, TESTIDS.backToCoo, "リーダーのスレッド"],
    [`/i/${instruction.id}`, TESTIDS.transcript, "指示の詳細"],
    ["/org", TESTIDS.orgChart, "組織図"],
    ["/settings", TESTIDS.settings, "設定"],
  ];
  for (const [path, testid, name] of screens) {
    await page.goto(path);
    await expect(byTestId(page, testid).first()).toBeVisible();
    expect(await htmlColorScheme(page), `${name}: color-scheme`).toContain("dark");
    expect(await groundLuminance(page), `${name}: 地が暗い`).toBeLessThan(0.05);
    const samples = await primaryTextContrast(page, "body");
    expect(samples.length, `${name}: 主要な文字が見つかる`).toBeGreaterThan(0);
    const low = samples.filter((s) => s.ratio < 4.5);
    expect(low, `${name}: コントラスト比 4.5 未満の文字`).toEqual([]);
  }

  // ───── 設定で `ライト` に固定 → OS がダークでもライト。再読み込みしても残る ─────
  await page.goto("/settings");
  await page.locator(`[data-testid="${TESTIDS.themeOption}"][data-value="light"]`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await htmlColorScheme(page)).toBe("light");
  expect(await page.evaluate((k) => localStorage.getItem(k), THEME_STORAGE_KEY)).toBe("light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await groundLuminance(page), "ライトの地は明るい").toBeGreaterThan(0.6);
  const lightSamples = await primaryTextContrast(page, "body");
  expect(lightSamples.filter((s) => s.ratio < 4.5), "ライトでもコントラスト比 4.5 以上").toEqual([]);

  // `自動` に戻すと OS（ダーク）に合わせる
  await page.locator(`[data-testid="${TESTIDS.themeOption}"][data-value="auto"]`).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "light");
  expect(await htmlColorScheme(page)).toContain("dark");
});
