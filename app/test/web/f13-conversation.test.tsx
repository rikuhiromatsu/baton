// F13 会話: ストリームの継ぎ足し・ack・未読と既読・楽観的送信の表示・書き手の見分け・自動スクロール（13.4・4.7・4.8）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2, type ListMessagesOutput, type ListThreadsOutput } from "@baton/shared";
import { qk } from "../../src/web/api/keys.ts";
import { markThreadRead } from "../../src/web/api/messages.ts";
import { applyServerEvent } from "../../src/web/api/ws.ts";
import { isGrouped, ThreadView } from "../../src/web/components/ThreadView.tsx";
import { useOutbox } from "../../src/web/state/outbox.ts";
import { applyDelta, useStreams } from "../../src/web/state/streams.ts";
import { useToasts } from "../../src/web/state/toasts.ts";
import { useUi } from "../../src/web/state/ui.ts";
import { json, makeQc, message, recordingTransport, thread, Wrap } from "./helpers.tsx";

beforeEach(() => {
  useStreams.setState({ byId: {} });
  useOutbox.setState({ items: {} });
  useToasts.setState({ toast: null });
  useUi.setState({ visibleThreadId: null });
});
afterEach(() => vi.useRealTimers());

function renderThread(qc = makeQc(), items = [message({ seq: 1 })]) {
  qc.setQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID), { items, hasMoreBefore: false });
  qc.setQueryData(qk.sidebar, { items: [], approvals: 0 });
  recordingTransport(() => json(204));
  render(
    <Wrap qc={qc}>
      <ThreadView threadId={COO_THREAD_ID} kind="coo" projectId={null} />
    </Wrap>,
  );
  return qc;
}

describe("F13 ストリーム", () => {
  it("差分は offset で継ぎ足し、重なりは捨て、reset で書き直し、飛んでいたら null", () => {
    expect(applyDelta("", { offset: 0, delta: "なん" })).toBe("なん");
    expect(applyDelta("なん", { offset: 2, delta: "の動画" })).toBe("なんの動画");
    expect(applyDelta("なんの動画", { offset: 2, delta: "の動画" })).toBe("なんの動画");
    expect(applyDelta("前置き", { offset: 0, delta: "本文", reset: true })).toBe("本文");
    expect(applyDelta("なん", { offset: 5, delta: "x" })).toBeNull();
  });

  it("message.delta で吹き出しの本文が伸び、complete で完成した本文になる", async () => {
    const qc = makeQc();
    const streaming = message({ seq: 2, status: "streaming", body: "" });
    renderThread(qc, [message({ seq: 1 }), streaming]);
    // 文字がまだ無いときは入力中の印
    expect(await screen.findByTestId(TESTIDS.messageTyping)).toBeTruthy();
    act(() => {
      applyServerEvent(qc, { t: "message.upserted", message: streaming, bodyTruncated: false });
      applyServerEvent(qc, { t: "message.delta", threadId: COO_THREAD_ID, messageId: streaming.id, offset: 0, delta: "なんの", activity: "返事を書いている" });
      applyServerEvent(qc, { t: "message.delta", threadId: COO_THREAD_ID, messageId: streaming.id, offset: 3, delta: "動画ですか？" });
    });
    await waitFor(() => expect(document.querySelector(`[data-seq="2"]`)!.textContent).toContain("なんの動画ですか？"));
    expect(document.querySelector(`[data-seq="2"]`)!.getAttribute("data-status")).toBe("streaming");
    act(() => applyServerEvent(qc, { t: "message.upserted", message: { ...streaming, body: "なんの動画ですか？", status: "complete", updatedAt: streaming.updatedAt + 1 }, bodyTruncated: false }));
    await waitFor(() => expect(document.querySelector(`[data-seq="2"]`)!.getAttribute("data-status")).toBe("complete"));
    expect(useStreams.getState().byId[streaming.id]).toBeUndefined();
  });

  it("飛んだ差分が来たら REST から取り直す", () => {
    const qc = makeQc();
    qc.setQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID), { items: [], hasMoreBefore: false });
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyServerEvent(qc, { t: "message.delta", threadId: COO_THREAD_ID, messageId: "x", offset: 10, delta: "y" });
    expect(spy).toHaveBeenCalledWith({ queryKey: qk.messages(COO_THREAD_ID) });
  });
});

describe("F13 見え方", () => {
  it("書き手: CEO は右（data-author=ceo）、COO・リーダー・秘書は名前と役割の色", async () => {
    renderThread(makeQc(), [
      message({ seq: 1, authorKind: "ceo", authorAgentId: null, body: "台本を作りたい" }),
      message({ seq: 2, authorKind: "coo", body: "なんの動画ですか？" }),
      message({ seq: 3, authorKind: "leader", authorAgentId: "agent-x-leader", body: "了解です" }),
      message({ seq: 4, authorKind: "secretary", authorAgentId: null, authorName: "秘書", body: "確認したいです" }),
    ]);
    const msgs = await screen.findAllByTestId(TESTIDS.message);
    expect(msgs.map((m) => m.getAttribute("data-author"))).toEqual(["ceo", "coo", "leader", "secretary"]);
    expect(msgs[1]!.querySelector(".author--coo")!.textContent).toContain(UI_TEXT_V2.roles.coo);
    expect(msgs[2]!.querySelector(".author--leader")!.textContent).toContain(UI_TEXT_V2.roles.leader);
    expect(msgs[3]!.textContent).toContain(UI_TEXT_V2.conversation.fromSecretary);
  });

  it("相づちには既読（ack）の印", async () => {
    renderThread(makeQc(), [message({ seq: 1, authorKind: "ceo", authorAgentId: null, body: "たすかる！", reaction: "ack" })]);
    expect(await screen.findByTestId(TESTIDS.messageAck)).toBeTruthy();
    expect(screen.getByTestId(TESTIDS.messageAck).textContent).toBe(UI_TEXT_V2.conversation.read);
  });

  it("送信待ちの発言はすぐ出て、届いたら同じ場所で置き換わる", async () => {
    const qc = makeQc();
    useOutbox.getState().put({ clientId: "cid-1", target: { kind: "thread", threadId: COO_THREAD_ID }, body: "コーヒー紹介のやつ", createdAt: Date.now(), state: "sending" });
    renderThread(qc, [message({ seq: 1 })]);
    const local = await screen.findByText("コーヒー紹介のやつ");
    expect(local.closest("[data-testid]")!.getAttribute("data-status")).toBe("local-sending");
    act(() =>
      qc.setQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID), (old) => ({
        ...old!,
        items: [...old!.items, message({ seq: 2, authorKind: "ceo", authorAgentId: null, clientId: "cid-1", body: "コーヒー紹介のやつ" })],
      })),
    );
    await waitFor(() => expect(useOutbox.getState().items["cid-1"]).toBeUndefined());
    expect(screen.getAllByText("コーヒー紹介のやつ")).toHaveLength(1);
  });

  it("同じ書き手が続いたら名前を省く（CEO とシステムは省かない）", () => {
    const a = message({ seq: 1, authorKind: "coo", createdAt: 1000 });
    expect(isGrouped(a, message({ seq: 2, authorKind: "coo", createdAt: 2000 }))).toBe(true);
    expect(isGrouped(a, message({ seq: 2, authorKind: "leader", createdAt: 2000 }))).toBe(false);
    expect(isGrouped(a, message({ seq: 2, authorKind: "coo", createdAt: 1000 + 6 * 60_000 }))).toBe(false);
    expect(isGrouped(message({ authorKind: "ceo", authorAgentId: null }), message({ authorKind: "ceo", authorAgentId: null }))).toBe(false);
  });

  it("下にいるときは新しい発言に追従する（scrollTop を一番下へ）", async () => {
    const qc = renderThread(makeQc(), [message({ seq: 1 })]);
    const scroller = document.querySelector(".thread__scroll") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 5000 });
    act(() => qc.setQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID), (old) => ({ ...old!, items: [...old!.items, message({ seq: 2 })] })));
    await waitFor(() => expect(scroller.scrollTop).toBe(5000));
  });
});

describe("F13 未読と既読（4.8）", () => {
  it("一番下が見えたら既読にして未読を 0 に、POST は 1 秒にまとめる", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const qc = makeQc();
    qc.setQueryData<ListThreadsOutput>(qk.threads, { items: [thread({ id: "thread-read", unread: 3, lastSeq: 7, lastReadSeq: 4 })] });
    const { calls } = recordingTransport(() => json(204));
    markThreadRead(qc, "thread-read", 6);
    markThreadRead(qc, "thread-read", 7);
    expect(qc.getQueryData<ListThreadsOutput>(qk.threads)!.items[0]!.unread).toBe(0);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/threads/thread-read/read");
    expect(calls[0]!.body).toEqual({ seq: 7 });
  });

  it("いま見ていないスレッドに notify=1 の発言が完成したらトースト。見ているスレッドでは出さない", () => {
    const qc = makeQc();
    qc.setQueryData<ListThreadsOutput>(qk.threads, { items: [thread()] });
    useUi.setState({ visibleThreadId: "thread-leader-x" });
    applyServerEvent(qc, { t: "message.upserted", message: message({ notify: true, body: "報告です" }), bodyTruncated: false });
    expect(useToasts.getState().toast?.kind).toBe("message");
    useToasts.setState({ toast: null });
    useUi.setState({ visibleThreadId: COO_THREAD_ID });
    applyServerEvent(qc, { t: "message.upserted", message: message({ notify: true, body: "もう一つ" }), bodyTruncated: false });
    expect(useToasts.getState().toast).toBeNull();
    // notify=0 は出さない
    useUi.setState({ visibleThreadId: null });
    applyServerEvent(qc, { t: "message.upserted", message: message({ notify: false }), bodyTruncated: false });
    expect(useToasts.getState().toast).toBeNull();
  });
});
