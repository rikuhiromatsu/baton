// 画面まわりの小さな道具（testid は packages/shared の TESTIDS だけを使う）
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { BOOT_COMPOSER_ID, BOOT_SKELETON_ID, TESTIDS, type InstructionStatus } from "@baton/shared";
import type { ProjectName } from "./env.ts";

export const byTestId = (page: Page | Locator, id: string): Locator => page.locator(`[data-testid="${id}"]`);

/**
 * 指示の入力欄。JS の読み込み前は index.html の #boot-composer、React の起動後は composer-input（7.4）。
 * どちらか見えている方を返す。
 */
export function composer(page: Page): Locator {
  return page.locator(`[data-testid="${TESTIDS.composerInput}"]:visible, #${BOOT_COMPOSER_ID}:visible`).first();
}

/** 全画面スケルトン（index.html の #boot-skeleton か、React の skeleton-screen） */
export function skeleton(page: Page): Locator {
  return page.locator(`[data-testid="${TESTIDS.skeletonScreen}"]:visible, #${BOOT_SKELETON_ID}:visible`).first();
}

/** 対象外のプロジェクトでは skip する（8.3 の表の「対象」列） */
export function onlyOn(testInfo: TestInfo, projects: readonly ProjectName[]): void {
  test.skip(!projects.includes(testInfo.project.name as ProjectName), `対象外（${projects.join(", ")} のみ）`);
}

export function isTouchProject(testInfo: TestInfo): boolean {
  return testInfo.project.use.hasTouch === true;
}

/** タッチ端末では tap、デスクトップでは click */
export async function press(locator: Locator, testInfo: TestInfo): Promise<void> {
  if (isTouchProject(testInfo)) await locator.tap();
  else await locator.click();
}

/**
 * テストごとに一意な文字列。本文の先頭に置く（件名は本文の先頭 20 文字になるので、カードにも出る）。
 * 他のテストのカードと取り違えないために使う。
 */
export function uniqueMarker(label: string, testInfo: TestInfo): string {
  const project = testInfo.project.name === "desktop-chromium" ? "d" : testInfo.project.name === "iphone-chromium" ? "c" : "w";
  const rand = Math.random().toString(36).slice(2, 7);
  return `${label}${project}${rand}`;
}

/**
 * 指定した ID のカードの data-status の移り変わりを、ページの中で記録し始める。
 * カードはまとまりの移動で DOM ごと作り直されることがあるので、要素ではなく文書全体を見張る。
 */
export async function trackStatuses(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ({ id, testid }) => {
      const w = window as unknown as { __batonStatusLog?: Record<string, string[]> };
      const logs = (w.__batonStatusLog ??= {});
      const log = (logs[id] ??= []);
      const record = () => {
        const el = document.querySelector(`[data-testid="${testid}"][data-id="${id}"]`);
        const status = el?.getAttribute("data-status");
        if (status && log[log.length - 1] !== status) log.push(status);
      };
      record();
      new MutationObserver(record).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-status", "data-id"],
      });
    },
    { id, testid: TESTIDS.instructionCard },
  );
}

export async function trackedStatuses(page: Page, id: string): Promise<InstructionStatus[]> {
  return page.evaluate((id) => {
    const w = window as unknown as { __batonStatusLog?: Record<string, string[]> };
    return (w.__batonStatusLog?.[id] ?? []) as never;
  }, id);
}

/**
 * 「変わらないこと」を確かめる。durationMs の間、read() の値が最初の値のままであること。
 * 待つ時間そのものが検査の中身なので、固定時間の待ちを使う数少ない場所。
 */
export async function expectStable<T>(read: () => Promise<T>, durationMs: number, message: string): Promise<T> {
  const first = await read();
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now: unknown = await read();
    expect(now, message).toEqual(first);
  }
  return first;
}
