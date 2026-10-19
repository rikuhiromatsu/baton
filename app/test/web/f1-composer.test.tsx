// F1 Composer: #boot-composer の値とフォーカスを引き継ぐ、⌘Enter で送信、空白だけは送らない、送信後に空になる、失敗で再送ボタン
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TESTIDS, UI_TEXT } from "@baton/shared";
import { Composer } from "../../src/web/components/Composer.tsx";
import { InstructionList } from "../../src/web/components/InstructionList.tsx";
import { useActiveList } from "../../src/web/api/queries.ts";
import { useDraft } from "../../src/web/state/draft.ts";
import { useOutbox } from "../../src/web/state/outbox.ts";
import { useUi } from "../../src/web/state/ui.ts";
import { json, listItems, makeQc, recordingTransport, seedList, summary, Wrap, type Call } from "./helpers.tsx";

function Home() {
  const list = useActiveList();
  return (
    <>
      {list.data && <InstructionList items={list.data.items} now={Date.now()} onOpen={() => {}} />}
      <Composer />
    </>
  );
}

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

const tick = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => {
  useDraft.setState({ text: "" });
  useOutbox.setState({ items: {} });
  useUi.setState({ bubble: null, listRevealed: true });
  document.getElementById("boot-composer-wrap")?.remove();
});

describe("F1 Composer", () => {
  it("埋め込みの入力欄の値・選択範囲・フォーカスを引き継いで置き換える", () => {
    bootComposer("打ちかけの指示", 3, true);
    const qc = makeQc();
    render(
      <Wrap qc={qc}>
        <Composer />
      </Wrap>,
    );
    expect(document.getElementById("boot-composer")).toBeNull();
    expect(document.getElementById("boot-composer-wrap")).toBeNull();
    const el = input();
    expect(el.value).toBe("打ちかけの指示");
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(3);
    expect(el.getAttribute("aria-label")).toBe(UI_TEXT.composerAria);
    expect(useDraft.getState().text).toBe("打ちかけの指示");
  });

  it("フォーカスしていなかったときは値だけ引き継ぐ", () => {
    bootComposer("値だけ", 0, false);
    const qc = makeQc();
    render(
      <Wrap qc={qc}>
        <Composer />
      </Wrap>,
    );
    expect(input().value).toBe("値だけ");
  });

  it("⌘Enter で送信し、送信後に空になる。一覧の待機に楽観的に出る", async () => {
    const qc = makeQc();
    seedList(qc, []);
    const { calls } = recordingTransport((c) =>
      c.method === "POST" ? json(201, summary({ id: "srv-1", clientId: (c.body as { clientId: string }).clientId, body: "調べて" })) : json(200, { items: [], nextCursor: null }),
    );
    render(
      <Wrap qc={qc}>
        <Home />
      </Wrap>,
    );
    fireEvent.change(input(), { target: { value: "調べて" } });
    expect((screen.getByTestId(TESTIDS.composerSend) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await tick();
    await tick();
    expect(input().value).toBe("");
    const posts = calls.filter((c: Call) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ body: "調べて" });
    await waitFor(() => expect(listItems(qc).map((i) => i.id)).toEqual(["srv-1"]));
    const card = screen.getByTestId(TESTIDS.instructionCard);
    expect(card.getAttribute("data-status")).toBe("queued");
  });

  it("Enter だけでは送らない（改行）。Ctrl+Enter でも送れる", async () => {
    const qc = makeQc();
    seedList(qc, []);
    const { calls } = recordingTransport((c) => json(201, summary({ clientId: (c.body as { clientId: string }).clientId })));
    render(
      <Wrap qc={qc}>
        <Composer />
      </Wrap>,
    );
    fireEvent.change(input(), { target: { value: "一行目" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await tick();
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("空白だけは送らない", async () => {
    const qc = makeQc();
    seedList(qc, []);
    const { calls } = recordingTransport(() => json(201, {}));
    render(
      <Wrap qc={qc}>
        <Composer />
      </Wrap>,
    );
    fireEvent.change(input(), { target: { value: "   \n  " } });
    expect((screen.getByTestId(TESTIDS.composerSend) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByTestId(TESTIDS.composerSend));
    await tick();
    expect(calls).toHaveLength(0);
    expect(listItems(qc)).toHaveLength(0);
  });

  it("失敗したらカードを赤くして再送ボタンを出し、押すと同じ clientId で送り直す", async () => {
    const qc = makeQc();
    seedList(qc, []);
    let fail = true;
    const { calls } = recordingTransport((c) => {
      if (c.method !== "POST") return json(200, { items: listItems(qc), nextCursor: null });
      return fail ? json(503, { error: { code: "internal", message: "down" } }) : json(201, summary({ id: "srv-9", clientId: (c.body as { clientId: string }).clientId, body: "失敗する指示" }));
    });
    render(
      <Wrap qc={qc}>
        <Home />
      </Wrap>,
    );
    fireEvent.change(input(), { target: { value: "失敗する指示" } });
    fireEvent.click(screen.getByTestId(TESTIDS.composerSend));
    await tick();
    await tick();
    const card = await screen.findByTestId(TESTIDS.instructionCard);
    await waitFor(() => expect(card.getAttribute("data-failed-send")).toBe("true"));
    const resend = screen.getAllByRole("button", { name: UI_TEXT.resend })[0]!;
    fail = false;
    fireEvent.click(resend);
    await waitFor(() => expect(listItems(qc).map((i) => i.id)).toEqual(["srv-9"]));
    const posts = calls.filter((c) => c.method === "POST").map((c) => (c.body as { clientId: string }).clientId);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    await waitFor(() => expect(screen.getByTestId(TESTIDS.instructionCard).getAttribute("data-failed-send")).toBeNull());
  });
});
