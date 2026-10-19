// F12 サイドパネル（13.3）: 一番上に COO、承認待ち（あるときだけ）、進行中のプロジェクト（件数のチップは 0 を出さない）、
// 吹き出しアイコンでリーダーのスレッド、選ぶと /p/:id（会話は COO のまま・チップ）、⌘\ でレール
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { setMedia } from "./setup.ts";
import { bootApp, disposeApp } from "./helpers.tsx";

function wide(on: boolean) {
  setMedia("(min-width: 1280px)", on);
  setMedia("(min-width: 1024px)", on);
}

afterEach(() => {
  disposeApp();
  wide(false);
});

describe("F12 サイドパネル", () => {
  it("COO が一番上、承認待ち、プロジェクトの行と件数（0 は出さない）", async () => {
    wide(true);
    await bootApp("/");
    const sidebar = await screen.findByTestId(TESTIDS.sidebar);
    const coo = await within(sidebar).findByTestId(TESTIDS.sidebarCoo);
    const items = await within(sidebar).findAllByTestId(TESTIDS.sidebarItem);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(coo.compareDocumentPosition(items[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sidebar).getByTestId(TESTIDS.sidebarApprovals).textContent).toContain(UI_TEXT_V2.sidebar.approvals);
    // 判断待ちのあるプロジェクト（承認待ちの既存リポジトリ）が一番上
    expect(items[0]!.textContent).toContain("ショート動画の自動編集");
    for (const chip of within(sidebar).getAllByTestId(TESTIDS.sidebarCount)) {
      expect(chip.textContent).not.toBe("0");
      expect(["needs_decision", "review", "running"]).toContain(chip.getAttribute("data-kind"));
    }
    expect(within(sidebar).getAllByTestId(TESTIDS.sidebarLeaderLink).length).toBe(items.length);
  });

  it("プロジェクトを選ぶと /p/:id。会話は COO のまま、入力欄にチップ、行が選ばれた印", async () => {
    wide(true);
    const { router } = await bootApp("/");
    const sidebar = await screen.findByTestId(TESTIDS.sidebar);
    const item = (await within(sidebar).findAllByTestId(TESTIDS.sidebarItem)).find((x) => x.textContent?.includes("コーヒーのレシピ集"))!;
    fireEvent.click(item);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/${item.getAttribute("data-project-id")}`));
    await waitFor(() => expect(within(screen.getByTestId(TESTIDS.sidebar)).getAllByTestId(TESTIDS.sidebarItem).find((x) => x.getAttribute("data-active") === "true")).toBeTruthy());
    expect((await screen.findAllByTestId(TESTIDS.thread))[0]!.getAttribute("data-kind")).toBe("coo");
    expect((await screen.findByTestId(TESTIDS.contextChip)).textContent).toContain("コーヒーのレシピ集");
    // 吹き出しアイコンでリーダーのスレッド
    fireEvent.click(within(screen.getByTestId(TESTIDS.sidebar)).getAllByTestId(TESTIDS.sidebarLeaderLink)[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/leader$/));
  });

  it("⌘\\ でレールに（幅の印が変わる）", async () => {
    wide(true);
    await bootApp("/");
    const sidebar = await screen.findByTestId(TESTIDS.sidebar);
    expect(sidebar.getAttribute("data-mode")).toBe("fixed");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
    });
    await waitFor(() => expect(screen.getByTestId(TESTIDS.sidebar).getAttribute("data-mode")).toBe("rail"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
    });
    await waitFor(() => expect(screen.getByTestId(TESTIDS.sidebar).getAttribute("data-mode")).toBe("fixed"));
  });

  it("モバイルはドロワー（ボタンで開く）", async () => {
    wide(false);
    await bootApp("/");
    fireEvent.click(await screen.findByTestId(TESTIDS.sidebarToggle));
    const drawer = await screen.findByTestId(TESTIDS.sidebarDrawer);
    expect(within(drawer).getByTestId(TESTIDS.sidebarCoo)).toBeTruthy();
    expect(screen.queryByTestId(TESTIDS.sidebar)).toBeNull();
  });
});
