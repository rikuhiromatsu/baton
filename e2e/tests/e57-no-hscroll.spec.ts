// E57 390px で横スクロールが出ない（DESIGN-v2 13.13）。v2 の画面をすべて回る:
// / ・ /p/:id ・ /p/:id/leader ・ /i/:id ・ /org（プロジェクトの列は内側だけ横に動く）・ /settings ・ /archive
import { TESTIDS } from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, cardsPanel, expectNoHorizontalScroll, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E57 iPhone の幅（390px）でどの画面も横にはみ出さない", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.iphoneWebkit]);
  const marker = uniqueMarker("E57", testInfo);
  const { instruction } = await api.createAndWait(marker, `長い件名${"x".repeat(120)}`);
  const projectId = instruction.projectId!;

  const screens: [string, string, string][] = [
    ["/", TESTIDS.thread, "ホーム（COO）"],
    [`/p/${projectId}`, TESTIDS.thread, "プロジェクトを選んだホーム"],
    [`/p/${projectId}/leader`, TESTIDS.backToCoo, "リーダーのスレッド"],
    [`/i/${instruction.id}`, TESTIDS.transcript, "指示の詳細"],
    ["/org", TESTIDS.orgChart, "組織図"],
    ["/settings", TESTIDS.settings, "設定"],
    ["/archive", TESTIDS.archiveList, "アーカイブ"],
  ];
  for (const [path, testid, name] of screens) {
    await page.goto(path);
    await expect(byTestId(page, testid).first()).toBeVisible();
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    await expectNoHorizontalScroll(page, name);
  }

  // `指示` のシートを開いた状態でも
  await page.goto("/");
  await cardsPanel(page, testInfo);
  await expectNoHorizontalScroll(page, "指示のシート");
});
