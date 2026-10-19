// 画面まわりの小さな道具（testid は packages/shared の TESTIDS だけを使う）
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { BOOT_COMPOSER_ID, BOOT_SKELETON_ID, TESTIDS, type InstructionStatus, type ThreadMessage } from "@baton/shared";
import { RUNNER_TIMEOUT, type ProjectName } from "./env.ts";
import { cardById } from "./swipe.ts";

export const byTestId = (page: Page | Locator, id: string): Locator => page.locator(`[data-testid="${id}"]`);

/**
 * 入力欄。JS の読み込み前は index.html の #boot-composer（COO 宛て。13.5）、React の起動後は composer-input。
 * どちらか見えている方を返す。
 */
export function composer(page: Page): Locator {
  return page.locator(`[data-testid="${TESTIDS.composerInput}"]:visible, #${BOOT_COMPOSER_ID}:visible`).first();
}

/** 全画面スケルトン（index.html の #boot-skeleton か、React の skeleton-screen） */
export function skeleton(page: Page): Locator {
  return page.locator(`[data-testid="${TESTIDS.skeletonScreen}"]:visible, #${BOOT_SKELETON_ID}:visible`).first();
}

/** 対象外のプロジェクトでは skip する（15.3 の表の「対象」列） */
export function onlyOn(testInfo: TestInfo, projects: readonly ProjectName[]): void {
  test.skip(!projects.includes(testInfo.project.name as ProjectName), `対象外（${projects.join(", ")} のみ）`);
}

export function isTouchProject(testInfo: TestInfo): boolean {
  return testInfo.project.use.hasTouch === true;
}

/** 画面幅 1024px 以上（サイドパネルと指示カードの列が出る。13.3・13.4） */
export function isWide(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 1024;
}

/** タッチ端末では tap、デスクトップでは click */
export async function press(locator: Locator, testInfo: TestInfo): Promise<void> {
  if (isTouchProject(testInfo)) await locator.tap();
  else await locator.click();
}

/**
 * テストごとに一意な文字列。本文の先頭に置く（他のテストのカード・発言と取り違えないため）。
 * 偽 claude の台本のマーカー（[slow] など）と紛れないよう、角かっこは使わない
 */
export function uniqueMarker(label: string, testInfo: TestInfo): string {
  const project = testInfo.project.name === "desktop-chromium" ? "d" : testInfo.project.name === "iphone-chromium" ? "c" : "w";
  const rand = Math.random().toString(36).slice(2, 7);
  return `${label}${project}${rand}`;
}

// ───────────── 会話（13.4） ─────────────

/** 入力欄に打って送る（⌘Enter ではなく送信ボタン。iOS と同じ操作） */
export async function sendFromComposer(page: Page, text: string, testInfo: TestInfo): Promise<void> {
  const input = byTestId(page, TESTIDS.composerInput).first();
  await expect(input).toBeVisible();
  await press(input, testInfo);
  await input.fill(text);
  await press(byTestId(page, TESTIDS.composerSend).first(), testInfo);
  await expect(input).toHaveValue("");
}

/** 画面の会話の発言（data-seq・data-author・data-kind・data-status。13.15） */
export type MessageView = { seq: number; author: string; kind: string; status: string; text: string };

export async function visibleMessages(page: Page): Promise<MessageView[]> {
  return page.evaluate((testid) => {
    return Array.from(document.querySelectorAll(`[data-testid="${testid}"]`)).map((el) => ({
      seq: Number(el.getAttribute("data-seq") ?? "-1"),
      author: el.getAttribute("data-author") ?? "",
      kind: el.getAttribute("data-kind") ?? "",
      status: el.getAttribute("data-status") ?? "",
      text: (el as HTMLElement).innerText ?? el.textContent ?? "",
    }));
  }, TESTIDS.message);
}

export type MessageViewMatch = {
  author?: ThreadMessage["authorKind"];
  kind?: ThreadMessage["kind"];
  text?: string;
  afterSeq?: number;
  status?: ThreadMessage["status"] | null;
};

function matchView(m: MessageView, want: MessageViewMatch): boolean {
  if (want.author !== undefined && m.author !== want.author) return false;
  if (want.kind !== undefined && m.kind !== want.kind) return false;
  if (want.text !== undefined && !m.text.includes(want.text)) return false;
  if (want.afterSeq !== undefined && m.seq <= want.afterSeq) return false;
  const status = want.status === undefined ? "complete" : want.status;
  if (status !== null && m.status !== status) return false;
  return true;
}

/** 画面に条件に合う発言が出るまで待ち、その seq を返す */
export async function expectMessageOnScreen(page: Page, want: MessageViewMatch, timeout = RUNNER_TIMEOUT): Promise<number> {
  let seq = -1;
  await expect
    .poll(
      async () => {
        const hit = (await visibleMessages(page)).find((m) => matchView(m, want));
        seq = hit?.seq ?? -1;
        return hit !== undefined;
      },
      { message: `画面に ${JSON.stringify(want)} の発言`, timeout, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  return seq;
}

/** seq で発言の要素を引く */
export function messageBySeq(page: Page, seq: number): Locator {
  return page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${seq}"]`);
}

// ───────────── 指示カード（13.8） ─────────────

/**
 * 指示カードの入れ物。≥ 1024px は右の列（常に見える）、それより狭いと上部バーの `指示` で開くシート。
 * どちらも cards-panel（13.15）。開いていなければ開く
 */
export async function cardsPanel(page: Page, testInfo: TestInfo): Promise<Locator> {
  const panel = byTestId(page, TESTIDS.cardsPanel).first();
  if (await panel.isVisible().catch(() => false)) return panel;
  const button = byTestId(page, TESTIDS.cardsButton).first();
  await expect(button).toBeVisible();
  await press(button, testInfo);
  await expect(panel).toBeVisible();
  return panel;
}

/** カードの入れ物を開いて、そのカードを返す */
export async function cardInPanel(page: Page, testInfo: TestInfo, id: string): Promise<Locator> {
  const panel = await cardsPanel(page, testInfo);
  return cardById(panel, id);
}

// ───────────── サイドパネル（13.3） ─────────────

/** サイドパネル（≥ 1280px は常時、狭いとドロワー）を見える状態にして返す */
export async function openSidebar(page: Page, testInfo: TestInfo): Promise<Locator> {
  const fixed = byTestId(page, TESTIDS.sidebar).first();
  const drawer = byTestId(page, TESTIDS.sidebarDrawer).first();
  if (await drawer.isVisible().catch(() => false)) return drawer;
  if ((page.viewportSize()?.width ?? 0) >= 1280 && (await fixed.isVisible().catch(() => false))) return fixed;
  await press(byTestId(page, TESTIDS.sidebarToggle).first(), testInfo);
  // 1024〜1279px はレールが重なって開く（sidebar）、それ未満はドロワー
  await expect(drawer.or(fixed)).toBeVisible();
  return (await drawer.isVisible().catch(() => false)) ? drawer : fixed;
}

export function sidebarItem(scope: Page | Locator, projectId: string): Locator {
  return scope.locator(`[data-testid="${TESTIDS.sidebarItem}"][data-project-id="${projectId}"]`);
}

// ───────────── 組織図（13.9） ─────────────

export function orgNode(page: Page, agentId: string): Locator {
  return page.locator(`[data-testid="${TESTIDS.orgNode}"][data-agent-id="${agentId}"]`);
}

/**
 * 組織図のエージェントのノードを見える状態にする。< 1024px はプロジェクトごとに折りたたみ（13.9）なので、
 * 見えなければそのプロジェクトの帯（org-project）を押して開く
 */
export async function revealOrgNode(page: Page, testInfo: TestInfo, agentId: string, projectName: string): Promise<Locator> {
  const node = orgNode(page, agentId);
  await expect(byTestId(page, TESTIDS.orgChart)).toBeVisible();
  if (!(await node.isVisible().catch(() => false))) {
    const band = byTestId(page, TESTIDS.orgProject).filter({ hasText: projectName }).first();
    await band.scrollIntoViewIfNeeded();
    await press(band, testInfo);
    // 帯を押すとプロジェクトのシートが開く作りなら閉じる（折りたたみの開閉はシートの外で行う）
    const sheet = byTestId(page, TESTIDS.projectSheet);
    if (await sheet.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  }
  await expect(node).toBeVisible();
  return node;
}

// ───────────── 状態の記録 ─────────────

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

/** 文書が横にはみ出していないこと（13.13: 390px で横スクロールを出さない） */
export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const l = await page.evaluate(() => {
    window.scrollTo(200, window.scrollY);
    const scrollX = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return {
      innerWidth: window.innerWidth,
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      scrollX,
    };
  });
  expect(l.docWidth, `${where}: 文書の横幅が画面幅を超えない`).toBeLessThanOrEqual(l.innerWidth);
  expect(l.bodyWidth, `${where}: body の横幅が画面幅を超えない`).toBeLessThanOrEqual(l.innerWidth);
  expect(l.scrollX, `${where}: 横にスクロールできない`).toBe(0);
}
