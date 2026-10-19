// F10 組織図（13.9）: CEO → COO → リーダー → メンバー、状態（data-state）、リアルタイムの変化と委任の光、
// ノードから会話・作業へ、長押しでエージェントのシート（職種・スキル・道具）
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AGENT_STATE_LABELS, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { qk } from "../../src/web/api/keys.ts";
import { sparkFor } from "../../src/web/screens/Org.tsx";
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

describe("F10 組織図", () => {
  it("委任の光: 動き出すと親 → 子、終わると子 → 親", () => {
    expect(sparkFor("idle", "running")).toBe("down");
    expect(sparkFor("queued", "awaiting_approval")).toBe("down");
    expect(sparkFor("running", "idle")).toBe("up");
    expect(sparkFor(undefined, "running")).toBeNull();
    expect(sparkFor("running", "running")).toBeNull();
    expect(sparkFor("running", "needs_decision")).toBeNull();
  });

  it("COO・リーダー・メンバーのノードと状態。承認待ちのメンバーがいる", async () => {
    wide(true);
    await bootApp("/org");
    const chart = await screen.findByTestId(TESTIDS.orgChart);
    const nodes = within(chart).getAllByTestId(TESTIDS.orgNode);
    expect(nodes.filter((n) => n.getAttribute("data-role") === "coo")).toHaveLength(1);
    expect(nodes.filter((n) => n.getAttribute("data-role") === "leader").length).toBeGreaterThanOrEqual(3);
    const waiting = nodes.find((n) => n.getAttribute("data-state") === "awaiting_approval")!;
    expect(waiting.textContent).toContain(AGENT_STATE_LABELS.awaiting_approval);
    expect(within(chart).getAllByTestId(TESTIDS.orgProject).length).toBeGreaterThanOrEqual(3);
  });

  it("リアルタイム: 取り直した状態が変わるとノードの状態も変わる", async () => {
    wide(true);
    const { qc, backend } = await bootApp("/org");
    await screen.findByTestId(TESTIDS.orgChart);
    const leader = screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.getAttribute("data-role") === "leader" && n.textContent?.includes("ナギ"))!;
    expect(leader.getAttribute("data-state")).toBe("idle");
    act(() => backend.setThread("thread-leader-shorts", { status: "running", talkingWithCeo: true }));
    await act(() => qc.invalidateQueries({ queryKey: qk.org }));
    await waitFor(() =>
      expect(screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.getAttribute("data-agent-id") === leader.getAttribute("data-agent-id"))!.getAttribute("data-state")).toBe("talking"),
    );
    expect(document.querySelector(".org-col--talking")).toBeTruthy();
  });

  it("COO を押すと会話、リーダーを押すとリーダーのスレッド", async () => {
    wide(true);
    const { router } = await bootApp("/org");
    await screen.findByTestId(TESTIDS.orgChart);
    fireEvent.click(screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.getAttribute("data-role") === "leader")!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\/[^/]+\/leader$/));
    await act(() => router.navigate({ to: "/org" }));
    await screen.findByTestId(TESTIDS.orgChart);
    fireEvent.click(screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.getAttribute("data-role") === "coo")!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("作業中のメンバーを押すとそのセッションの詳細", async () => {
    wide(true);
    const { router } = await bootApp("/org");
    await screen.findByTestId(TESTIDS.orgChart);
    fireEvent.click(screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.getAttribute("data-state") === "awaiting_approval")!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/i\//));
    expect((router.state.location.search as { s?: string }).s).toBeTruthy();
  });

  it("長押し（右クリック）でエージェントのシート: 職種・スキル・道具", async () => {
    wide(true);
    await bootApp("/org");
    await screen.findByTestId(TESTIDS.orgChart);
    const researcher = screen.getAllByTestId(TESTIDS.orgNode).find((n) => n.textContent?.includes("ミナ"))!;
    fireEvent.contextMenu(researcher);
    const sheet = await screen.findByTestId(TESTIDS.agentSheet);
    expect(sheet.textContent).toContain(UI_TEXT_V2.org.profile);
    await waitFor(() => expect(sheet.textContent).toContain("sns-url-research"));
    expect(sheet.textContent).toContain(UI_TEXT_V2.org.tools);
    expect(sheet.textContent).toContain("WebSearch");
  });

  it("モバイルは入れ子で、プロジェクトの帯を押すと折りたたむ", async () => {
    wide(false);
    await bootApp("/org");
    const chart = await screen.findByTestId(TESTIDS.orgChart);
    expect(chart.className).toContain("org-chart--stack");
    const band = within(chart).getAllByTestId(TESTIDS.orgProject)[0]!;
    expect(band.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(band);
    await waitFor(() => expect(band.getAttribute("aria-expanded")).toBe("false"));
    expect(band.closest(".org-project")!.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(band);
    await waitFor(() => expect(band.getAttribute("aria-expanded")).toBe("true"));
  });
});
