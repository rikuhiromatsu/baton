// F7 13.14 にない固定文言を出していない（主要画面を描画して、許可リスト外の日本語テキストノードがないことを検査）。
// AI が書いた文章・名前・利用者の入力（モックのデータ）は対象外
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ALLOWED_FIXED_TEXTS, ONBOARDING_STEPS, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { useUi } from "../../src/web/state/ui.ts";
import { setMedia } from "./setup.ts";
import { bootApp, disposeApp } from "./helpers.tsx";
import type { MockBackend } from "../../src/web/api/mock.ts";

const JA = /[぀-ヿ㐀-鿿！-｠]/;

function wide(on: boolean) {
  setMedia("(min-width: 1280px)", on);
  setMedia("(min-width: 1024px)", on);
}

/** 画面に出ている日本語の文字列（テキストノードと aria-label・title・placeholder） */
function visibleJapanese(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    // pre は生のデータ（道具の入力・結果・構造化出力の JSON）を出す場所
    if (n.parentElement?.closest("pre")) continue;
    const t = (n.textContent ?? "").trim();
    if (t && JA.test(t)) out.push(t);
  }
  for (const el of document.body.querySelectorAll("[aria-label],[title],[placeholder]")) {
    for (const attr of ["aria-label", "title", "placeholder"]) {
      const v = el.getAttribute(attr)?.trim();
      if (v && JA.test(v)) out.push(v);
    }
  }
  return out;
}

let backend: MockBackend;
function assertOnlyAllowed(where: string) {
  const dump = backend.dynamicTextDump();
  const bad = visibleJapanese().filter((t) => !ALLOWED_FIXED_TEXTS.includes(t) && !dump.includes(t));
  expect(bad, where).toEqual([]);
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

afterEach(() => {
  disposeApp();
  wide(false);
});

describe("F7 固定文言", () => {
  it("ホーム（会話・プロジェクト案・カード・サイドパネル）・メニュー・使用量", async () => {
    wide(true);
    const app = await bootApp("/");
    backend = app.backend;
    await screen.findAllByTestId(TESTIDS.message);
    await screen.findAllByTestId(TESTIDS.instructionCard);
    await screen.findByTestId(TESTIDS.proposalCard);
    await wait(50);
    assertOnlyAllowed("ホーム");
    fireEvent.click(screen.getByTestId(TESTIDS.menuButton));
    await screen.findByTestId(TESTIDS.menuLogout);
    assertOnlyAllowed("メニュー");
    fireEvent.click(screen.getByTestId(TESTIDS.menuUsage));
    await screen.findByTestId(TESTIDS.quotaSheet);
    assertOnlyAllowed("使用量");
  });

  it("フリックの取り消し・差し戻し・長押しのメニュー", async () => {
    wide(true);
    const app = await bootApp("/");
    backend = app.backend;
    const cards = await screen.findAllByTestId(TESTIDS.instructionCard);
    const review = cards.find((c) => c.getAttribute("data-status") === "review")!;
    fireEvent.contextMenu(review);
    await wait(30);
    assertOnlyAllowed("操作メニュー");
    act(() => useUi.getState().setActionMenu(null));
    fireEvent.keyDown(review, { key: "ArrowLeft" });
    await screen.findByTestId(TESTIDS.sendbackInput, {}, { timeout: 3000 });
    assertOnlyAllowed("差し戻し");
  });

  it("リーダーのスレッド", async () => {
    wide(true);
    const app = await bootApp("/p/proj-shorts/leader");
    backend = app.backend;
    await screen.findByTestId(TESTIDS.backToCoo);
    await screen.findAllByTestId(TESTIDS.message);
    await wait(50);
    assertOnlyAllowed("リーダーのスレッド");
  });

  it("指示の詳細（やりとり・承認・TODO・変更・報告・成果物・詳細の表示）", async () => {
    wide(true);
    const app = await bootApp("/");
    backend = app.backend;
    await screen.findAllByTestId(TESTIDS.instructionCard);
    const withApproval = [...backend.insts.values()].find((r) => r.summary.openDecisionCount > 0)!;
    await act(() => app.router.navigate({ to: "/i/$id", params: { id: withApproval.summary.id } }));
    await screen.findByTestId(TESTIDS.approvalCard, {}, { timeout: 3000 });
    assertOnlyAllowed("承認");
    const shorts = [...backend.insts.values()].find((r) => r.summary.title === "コーヒー紹介の台本 10 本")!;
    await act(() => app.router.navigate({ to: "/i/$id", params: { id: shorts.summary.id } }));
    await waitFor(() => expect(screen.getAllByTestId(TESTIDS.instructionSheet)).toHaveLength(1));
    await screen.findByTestId(TESTIDS.transcript);
    for (const tab of ["transcript", "todo", "diff", "report", "artifacts"] as const) {
      fireEvent.click(screen.getByTestId(TESTIDS.detailTab(tab)));
      await wait(60);
      assertOnlyAllowed(`詳細の ${tab}`);
    }
    fireEvent.click(screen.getByTestId(TESTIDS.detailTab("transcript")));
    await wait(30);
    fireEvent.click(within(screen.getByTestId(TESTIDS.viewMode)).getAllByRole("radio")[1]!);
    for (const t of screen.getAllByTestId(TESTIDS.sessionTab)) {
      fireEvent.click(t);
      await wait(60);
      assertOnlyAllowed(`詳細のタブ ${t.getAttribute("data-role")}`);
    }
  });

  it("組織図とシート", async () => {
    wide(true);
    const app = await bootApp("/org");
    backend = app.backend;
    await screen.findByTestId(TESTIDS.orgChart);
    assertOnlyAllowed("組織図");
    fireEvent.contextMenu(screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.getAttribute("data-role") === "member")!);
    await screen.findByTestId(TESTIDS.agentSheet);
    await wait(30);
    assertOnlyAllowed("エージェントのシート");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId(TESTIDS.agentSheet)).toBeNull());
    fireEvent.click(screen.getAllByTestId(TESTIDS.orgProject)[0]!);
    await screen.findByTestId(TESTIDS.projectSheet);
    assertOnlyAllowed("プロジェクトのシート");
  });

  it("設定（トークンを発行して 1 回だけ表示）・アーカイブ", async () => {
    wide(true);
    const app = await bootApp("/settings");
    backend = app.backend;
    await screen.findByTestId(TESTIDS.settings);
    await screen.findAllByTestId(TESTIDS.botTokenItem);
    assertOnlyAllowed("設定");
    fireEvent.change(screen.getByLabelText(UI_TEXT_V2.settings.name), { target: { value: "テスト" } });
    fireEvent.click(screen.getByTestId(TESTIDS.botTokenCreate));
    await screen.findByTestId(TESTIDS.botTokenValue);
    assertOnlyAllowed("トークンの発行");
    await act(() => app.router.navigate({ to: "/archive" }));
    await screen.findByTestId(TESTIDS.archiveList);
    assertOnlyAllowed("アーカイブ");
  });

  it("初回の案内（5 ステップ、最後に通知）", async () => {
    wide(true);
    const app = await bootApp("/");
    backend = app.backend;
    act(() => useUi.getState().setOnboardingOpen(true));
    const dialog = await screen.findByTestId(TESTIDS.onboarding);
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
      await waitFor(() => expect(dialog.getAttribute("data-step")).toBe(String(i)));
      await wait(300);
      assertOnlyAllowed(`案内 ${i}`);
      if (i < ONBOARDING_STEPS.length - 1) fireEvent.click(screen.getByTestId(TESTIDS.onboardingNext));
    }
    expect(within(dialog).getByTestId(TESTIDS.pushToggle)).toBeTruthy();
  });

  it("モバイル（ドロワー・指示のシート）とログイン", async () => {
    wide(false);
    const app = await bootApp("/");
    backend = app.backend;
    fireEvent.click(await screen.findByTestId(TESTIDS.sidebarToggle));
    await screen.findByTestId(TESTIDS.sidebarDrawer);
    assertOnlyAllowed("ドロワー");
    act(() => useUi.getState().setDrawerOpen(false));
    fireEvent.click(screen.getByTestId(TESTIDS.cardsButton));
    await screen.findByTestId(TESTIDS.cardsPanel);
    await screen.findAllByTestId(TESTIDS.instructionCard);
    assertOnlyAllowed("指示のシート");
    disposeApp();
    cleanup();
    const login = await bootApp("/login?e=forbidden", { loggedOut: true });
    backend = login.backend;
    await screen.findByTestId(TESTIDS.loginGoogle);
    assertOnlyAllowed("ログイン");
  });
});
