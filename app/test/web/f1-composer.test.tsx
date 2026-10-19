// F1 Composer: #boot-composer の値とフォーカスを引き継ぐ（二重 remove しない）、⌘Enter で送信、空白だけは送らない、送信後に空になる、
// 失敗で再送。v2: 宛先の表示（→ COO / → リーダー）とプロジェクトのチップ、ターン中は中断
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { COO_THREAD_ID, TESTIDS, UI_TEXT, UI_TEXT_V2 } from "@baton/shared";
import { Composer } from "../../src/web/components/Composer.tsx";
import { composerTarget, parseRoute, type ComposerTarget } from "../../src/web/lib/target.ts";
import { useDraft } from "../../src/web/state/draft.ts";
import { useOutbox } from "../../src/web/state/outbox.ts";
import { json, makeQc, message, recordingTransport, Wrap, type Call } from "./helpers.tsx";

const cooTarget = (): ComposerTarget => composerTarget(parseRoute("/"), { leaderThreadIdOf: () => null, projectNameOf: () => null, detailTarget: null, chipCleared: null })!;
const projectTarget = (): ComposerTarget =>
  composerTarget(parseRoute("/p/p1"), { leaderThreadIdOf: () => null, projectNameOf: () => "台本", detailTarget: null, chipCleared: null })!;
const leaderTarget = (): ComposerTarget =>
  composerTarget(parseRoute("/p/p1/leader"), { leaderThreadIdOf: () => "thread-leader-p1", projectNameOf: () => "台本", detailTarget: null, chipCleared: null })!;

function bootComposer(value: string, caret: number, focus: boolean): HTMLTextAreaElement {
  const wrap = document.createElement("div");
  wrap.id = "boot-composer-wrap";
  const ta = document.createElement("textarea");
  ta.id = "boot-composer";
  ta.value = value;
  wrap.appendChild(ta);
  document.body.appendChild(wrap);
  if (focus) ta.focus();
  ta.setSelectionRange(caret, caret);
  return ta;
}

function input(): HTMLTextAreaElement {
  return screen.getByTestId(TESTIDS.composerInput) as HTMLTextAreaElement;
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 30)));

beforeEach(() => {
  useDraft.setState({ texts: {} });
  useOutbox.setState({ items: {} });
  document.getElementById("boot-composer-wrap")?.remove();
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

describe("F1 Composer", () => {
  it("埋め込みの入力欄の値・選択範囲・フォーカスを引き継いで置き換える", () => {
    bootComposer("打ちかけの依頼", 3, true);
    render(
      <Wrap qc={makeQc()}>
        <Composer target={cooTarget()} />
      </Wrap>,
    );
    expect(document.getElementById("boot-composer")).toBeNull();
    expect(document.getElementById("boot-composer-wrap")).toBeNull();
    const el = input();
    expect(el.value).toBe("打ちかけの依頼");
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(3);
    expect(useDraft.getState().texts.coo).toBe("打ちかけの依頼");
  });

  it("引き継ぎの途中で blur が起きても二重に remove しない", () => {
    const ta = bootComposer("x", 1, true);
    const wrap = document.getElementById("boot-composer-wrap")!;
    const remove = vi.spyOn(wrap, "remove");
    ta.addEventListener("blur", () => wrap.remove());
    expect(() =>
      render(
        <Wrap qc={makeQc()}>
          <Composer target={cooTarget()} />
        </Wrap>,
      ),
    ).not.toThrow();
    expect(remove.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("⌘Enter で COO のスレッドへ送り、入力欄が空になる。空白だけは送らない", async () => {
    const { calls } = recordingTransport((c: Call) => json(201, { message: message({ authorKind: "ceo", clientId: (c.body as { clientId: string }).clientId }) }));
    render(
      <Wrap qc={makeQc()}>
        <Composer target={cooTarget()} />
      </Wrap>,
    );
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await tick();
    expect(calls).toHaveLength(0);
    fireEvent.change(input(), { target: { value: "ショート動画の台本 10 本作りたい" } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await tick();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.path).toBe(`/api/threads/${COO_THREAD_ID}/messages`);
    expect(calls[0]!.body).toMatchObject({ body: "ショート動画の台本 10 本作りたい" });
    expect(input().value).toBe("");
  });

  it("宛先の表示とプロジェクトのチップ（about）。チップの × で外す", async () => {
    const onClear = vi.fn();
    const { calls } = recordingTransport(() => json(201, { message: message({ authorKind: "ceo" }) }));
    render(
      <Wrap qc={makeQc()}>
        <Composer target={projectTarget()} onClearContext={onClear} />
      </Wrap>,
    );
    expect(screen.getByTestId(TESTIDS.threadTarget).textContent).toContain(UI_TEXT_V2.roles.coo);
    const chip = screen.getByTestId(TESTIDS.contextChip);
    expect(chip.textContent).toContain("台本");
    expect(chip.textContent).toContain(UI_TEXT_V2.conversation.about);
    fireEvent.change(input(), { target: { value: "急ぎで" } });
    fireEvent.click(screen.getByTestId(TESTIDS.composerSend));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ contextProjectId: "p1" });
    fireEvent.click(screen.getByTestId(TESTIDS.contextChipClear));
    expect(onClear).toHaveBeenCalled();
  });

  it("リーダーのスレッドではリーダー宛て（aria-label と宛先の表示）", () => {
    render(
      <Wrap qc={makeQc()}>
        <Composer target={leaderTarget()} />
      </Wrap>,
    );
    expect(input().getAttribute("aria-label")).toBe(UI_TEXT_V2.composer.leaderAria);
    expect(screen.getByTestId(TESTIDS.threadTarget).textContent).toContain(UI_TEXT_V2.roles.leader);
    expect(screen.getByTestId(TESTIDS.threadTarget).textContent).toContain("台本");
  });

  it("ターン中で空のときは中断のボタン。押すと onInterrupt", () => {
    const onInterrupt = vi.fn();
    render(
      <Wrap qc={makeQc()}>
        <Composer target={cooTarget()} running onInterrupt={onInterrupt} />
      </Wrap>,
    );
    const stop = screen.getByTestId(TESTIDS.interruptButton);
    expect(stop.getAttribute("aria-label")).toBe(UI_TEXT_V2.composer.interrupt);
    fireEvent.click(stop);
    expect(onInterrupt).toHaveBeenCalled();
  });

  it("返事待ちの帯", () => {
    render(
      <Wrap qc={makeQc()}>
        <Composer target={cooTarget()} awaitingReply />
      </Wrap>,
    );
    expect(screen.getByTestId(TESTIDS.awaitingReply).textContent).toContain(UI_TEXT_V2.sidebar.awaitingReply);
  });

  it("送れなかったら送信待ちに failed が残る（再送できる）", async () => {
    recordingTransport(() => json(500, { error: { code: "internal", message: "x" } }));
    render(
      <Wrap qc={makeQc()}>
        <Composer target={cooTarget()} />
      </Wrap>,
    );
    fireEvent.change(input(), { target: { value: "失敗する" } });
    fireEvent.click(screen.getByTestId(TESTIDS.composerSend));
    await waitFor(() => expect(Object.values(useOutbox.getState().items)[0]?.state).toBe("failed"));
    expect(UI_TEXT.resend).toBe("再送");
  });
});
