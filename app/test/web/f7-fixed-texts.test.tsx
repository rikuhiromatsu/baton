// F7 7.11 にない固定文言を出していない（主要画面を描画して、許可リスト外の日本語テキストノードがないことを検査）
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { ALLOWED_FIXED_TEXTS, TESTIDS } from "@baton/shared";
import { App } from "../../src/web/App.tsx";
import { setCsrfToken, setTransport } from "../../src/web/api/client.ts";
import { MockBackend, mockRawLog } from "../../src/web/api/mock.ts";
import { setSocketFactory } from "../../src/web/api/ws.ts";
import { registerMockHooks, setMockMode } from "../../src/web/lib/env.ts";
import { setTailnetDriver } from "../../src/web/lib/tailnet.ts";
import { createAppRouter } from "../../src/web/router.tsx";
import { useTailnet } from "../../src/web/state/tailnet.ts";
import { useToasts } from "../../src/web/state/toasts.ts";
import { useUi } from "../../src/web/state/ui.ts";
import { makeQc } from "./helpers.tsx";

const JA = /[぀-ヿ㐀-鿿！-｠]/;

let backend: MockBackend | null = null;

function boot(path: string, opts: { loggedOut?: boolean } = {}) {
  backend = new MockBackend({ loggedOut: opts.loggedOut, speed: 1 });
  setMockMode(true);
  setTransport(backend.fetch);
  setCsrfToken(null);
  setSocketFactory(backend.createSocket);
  setTailnetDriver({ fetch: async () => new Response("{}", { status: 200 }), openRawLog: mockRawLog });
  registerMockHooks({ login: () => backend!.login() });
  useTailnet.setState({ url: null, ok: false });
  useToasts.setState({ toast: null });
  useUi.setState({ listRevealed: true, actionMenu: null, sendBackFor: null, bubble: null });
  const qc = makeQc();
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
  render(<App queryClient={qc} router={router} persist={false} />);
  return { qc, router, backend };
}

/** 画面に出ている日本語の文字列（テキストノードと aria-label・title） */
function visibleJapanese(): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
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

function assertOnlyAllowed() {
  const dump = backend!.dynamicTextDump();
  const bad = visibleJapanese().filter((t) => !ALLOWED_FIXED_TEXTS.includes(t) && !dump.includes(t));
  expect(bad).toEqual([]);
}

afterEach(() => {
  backend?.dispose();
  backend = null;
  setMockMode(false);
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("F7 固定文言", () => {
  it("ホーム・メニュー・取り消しトースト", async () => {
    boot("/");
    await screen.findByTestId(TESTIDS.instructionList);
    await screen.findAllByTestId(TESTIDS.instructionCard);
    assertOnlyAllowed();
    // メニュー
    fireEvent.click(screen.getByTestId(TESTIDS.menuButton));
    await screen.findByTestId(TESTIDS.menuLogout);
    assertOnlyAllowed();
    fireEvent.click(screen.getByTestId(TESTIDS.menuButton));
    // キーボードで承認 → 取り消しトースト
    const review = screen.getAllByTestId(TESTIDS.instructionCard).find((c) => c.getAttribute("data-status") === "review")!;
    fireEvent.keyDown(review, { key: "ArrowRight" });
    await screen.findByTestId(TESTIDS.undoToast, {}, { timeout: 3000 });
    assertOnlyAllowed();
  });

  it("詳細シート（報告・タスク・成果物・ログ・生ログ・判断）", async () => {
    const { router } = boot("/");
    await screen.findAllByTestId(TESTIDS.instructionCard);
    const reviewId = [...backend!.recs.values()].find((r) => r.summary.status === "review")!.summary.id;
    await act(() => router.navigate({ to: "/i/$id", params: { id: reviewId } }));
    await screen.findByTestId(TESTIDS.reportText);
    await screen.findByTestId(TESTIDS.taskTree);
    fireEvent.click(screen.getAllByTestId(TESTIDS.artifactItem)[0]!.querySelector("button")!);
    await screen.findByTestId(TESTIDS.artifactPreview);
    await waitFor(() => expect(useTailnet.getState().ok).toBe(true));
    assertOnlyAllowed();
    // 生ログへ切り替え
    const raw = await screen.findByRole("tab", { name: "生ログ" });
    fireEvent.click(raw);
    await wait(700);
    assertOnlyAllowed();
    // 判断待ち
    const askId = [...backend!.recs.values()].find((r) => r.summary.status === "needs_decision")!.summary.id;
    await act(() => router.navigate({ to: "/i/$id", params: { id: askId } }));
    await screen.findByTestId(TESTIDS.decisionPanel);
    assertOnlyAllowed();
  });

  it("差し戻しシート", async () => {
    boot("/");
    await screen.findAllByTestId(TESTIDS.instructionCard);
    const review = screen.getAllByTestId(TESTIDS.instructionCard).find((c) => c.getAttribute("data-status") === "review")!;
    fireEvent.keyDown(review, { key: "ArrowLeft" });
    await screen.findByTestId(TESTIDS.sendbackInput, {}, { timeout: 3000 });
    assertOnlyAllowed();
  });

  it("プロジェクト・アーカイブ", async () => {
    const { router } = boot("/projects");
    await screen.findAllByTestId(TESTIDS.projectCard);
    assertOnlyAllowed();
    await act(() => router.navigate({ to: "/archive" }));
    await screen.findByTestId(TESTIDS.archiveList);
    await screen.findAllByTestId(TESTIDS.instructionCard);
    assertOnlyAllowed();
  });

  it("ログイン（エラー表示を含む）", async () => {
    const { router } = boot("/", { loggedOut: true });
    await screen.findByTestId(TESTIDS.loginGoogle);
    assertOnlyAllowed();
    await act(() => router.navigate({ to: "/login", search: { e: "forbidden" } }));
    await screen.findByTestId(TESTIDS.loginError);
    assertOnlyAllowed();
    await act(() => router.navigate({ to: "/login", search: { e: "1" } }));
    expect(screen.getByTestId(TESTIDS.loginError).textContent).toBe("ログインできませんでした");
    assertOnlyAllowed();
  });

  it("固定文言の一覧に、画面で使う文言がそろっている", () => {
    for (const t of ["Google でログイン", "元に戻す", "再送", "閉じる", "生ログ", "Mac mini で開く", "上限に達しました", "再読み込み"]) {
      expect(ALLOWED_FIXED_TEXTS).toContain(t);
    }
  });
});
