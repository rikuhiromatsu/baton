// F3 WebSocket のイベントでクエリキャッシュが更新される。hello で取り直す。購読（スレッド・指示）と presence を送る（12.5・10.2）
import { describe, expect, it, vi } from "vitest";
import {
  COO_THREAD_ID,
  type InstructionDetail,
  type ListInstructionsOutput,
  type ListMessagesOutput,
  type ListThreadsOutput,
  type SidebarOutput,
  type TranscriptItem,
  type TranscriptOutput,
} from "@baton/shared";
import { qk } from "../../src/web/api/keys.ts";
import { Realtime, applyServerEvent, backoffDelay, type SocketLike } from "../../src/web/api/ws.ts";
import { makeQc, message, seedList, summary, thread } from "./helpers.tsx";

function item(over: Partial<TranscriptItem>): TranscriptItem {
  return {
    id: `t-${Math.random()}`,
    sessionId: "s1",
    threadId: null,
    instructionId: "i1",
    seq: 0,
    kind: "text",
    author: "claude",
    toolName: null,
    toolUseId: null,
    parentToolUseId: null,
    summary: "",
    body: { text: "x" },
    truncated: false,
    isError: false,
    createdAt: 0,
    ...over,
  };
}

describe("F3 イベントの反映", () => {
  it("instruction.upserted で一覧と詳細が更新される。古いイベントは無視", () => {
    const qc = makeQc();
    const a = summary({ status: "running", updatedAt: 100 });
    seedList(qc, [a]);
    applyServerEvent(qc, { t: "instruction.upserted", instruction: { ...a, status: "review", updatedAt: 200 } });
    expect(qc.getQueryData<ListInstructionsOutput>(qk.list("active"))!.items[0]!.status).toBe("review");
    applyServerEvent(qc, { t: "instruction.upserted", instruction: { ...a, status: "running", updatedAt: 150 } });
    expect(qc.getQueryData<ListInstructionsOutput>(qk.list("active"))!.items[0]!.status).toBe("review");
  });

  it("message.upserted は seq の順で入り、同じ ID は置き換える", () => {
    const qc = makeQc();
    qc.setQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID), { items: [message({ seq: 3 })], hasMoreBefore: false });
    const m = message({ seq: 2, status: "streaming", body: "" });
    applyServerEvent(qc, { t: "message.upserted", message: m, bodyTruncated: false });
    applyServerEvent(qc, { t: "message.upserted", message: { ...m, status: "complete", body: "完成", updatedAt: m.updatedAt + 1 }, bodyTruncated: false });
    const items = qc.getQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID))!.items;
    expect(items.map((x) => x.seq)).toEqual([2, 3]);
    expect(items[0]!.body).toBe("完成");
  });

  it("thread.updated はスレッドの一覧とサイドパネルのリーダーのスレッドに入る", () => {
    const qc = makeQc();
    qc.setQueryData<ListThreadsOutput>(qk.threads, { items: [thread(), thread({ id: "tl", kind: "leader" })] });
    qc.setQueryData<SidebarOutput>(qk.sidebar, {
      approvals: 0,
      items: [{ project: { id: "p" } as never, counts: { running: 0, queued: 0, needsDecision: 0, review: 0, failed: 0, doneRecent: 0 }, leaderThread: thread({ id: "tl", kind: "leader" }), activeAgents: 0, activity: null, lastActivityAt: null, inProgress: false }],
    });
    applyServerEvent(qc, { t: "thread.updated", thread: thread({ id: "tl", kind: "leader", unread: 2, talkingWithCeo: true }) });
    expect(qc.getQueryData<ListThreadsOutput>(qk.threads)!.items[1]!.unread).toBe(2);
    expect(qc.getQueryData<SidebarOutput>(qk.sidebar)!.items[0]!.leaderThread.talkingWithCeo).toBe(true);
  });

  it("project.counts でサイドパネルの件数が変わる", () => {
    const qc = makeQc();
    qc.setQueryData<SidebarOutput>(qk.sidebar, {
      approvals: 0,
      items: [{ project: { id: "p" } as never, counts: { running: 0, queued: 0, needsDecision: 0, review: 0, failed: 0, doneRecent: 0 }, leaderThread: thread(), activeAgents: 0, activity: null, lastActivityAt: null, inProgress: false }],
    });
    applyServerEvent(qc, { t: "project.counts", projectId: "p", counts: { running: 1, queued: 0, needsDecision: 0, review: 2, failed: 0, doneRecent: 0 } });
    const it = qc.getQueryData<SidebarOutput>(qk.sidebar)!.items[0]!;
    expect(it.counts.review).toBe(2);
    expect(it.inProgress).toBe(true);
  });

  it("transcript.appended は、その指示で絞ったキャッシュと絞らないキャッシュの両方に足す", () => {
    const qc = makeQc();
    qc.setQueryData<TranscriptOutput>(qk.transcript("s1", null), { items: [item({ seq: 0 })], hasMoreBefore: false });
    qc.setQueryData<TranscriptOutput>(qk.transcript("s1", "i1"), { items: [], hasMoreBefore: false });
    qc.setQueryData<TranscriptOutput>(qk.transcript("s1", "i2"), { items: [], hasMoreBefore: false });
    applyServerEvent(qc, { t: "transcript.appended", items: [item({ seq: 1 }), item({ seq: 0 })] });
    expect(qc.getQueryData<TranscriptOutput>(qk.transcript("s1", null))!.items.map((x) => x.seq)).toEqual([0, 1]);
    expect(qc.getQueryData<TranscriptOutput>(qk.transcript("s1", "i1"))!.items).toHaveLength(2);
    expect(qc.getQueryData<TranscriptOutput>(qk.transcript("s1", "i2"))!.items).toHaveLength(0);
  });

  it("decision.upserted で判断待ちのまとまりへ先に動く", () => {
    const qc = makeQc();
    const a = summary({ id: "i9", status: "running" });
    seedList(qc, [a]);
    qc.setQueryData<InstructionDetail>(qk.detail("i9"), { instruction: { ...a }, decisions: [], openDecisions: [] } as unknown as InstructionDetail);
    applyServerEvent(qc, {
      t: "decision.upserted",
      decision: { id: "d1", instructionId: "i9", taskId: null, askedByAgentId: null, kind: "approval", sessionId: "s", question: "", options: [], toolName: "Bash", toolInput: { command: "npm i" }, status: "open", answer: null, verdict: null, suggestion: null, suggestionVerdict: null, suggestionAt: null, answeredAt: null, createdAt: 0 },
    });
    expect(qc.getQueryData<ListInstructionsOutput>(qk.list("active"))!.items[0]!.openDecisionCount).toBe(1);
    expect(qc.getQueryData<InstructionDetail>(qk.detail("i9"))!.openDecisions).toHaveLength(1);
  });

  it("hello で表示中のクエリを取り直す（session 以外）", () => {
    const qc = makeQc();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyServerEvent(qc, {
      t: "hello",
      serverTime: 0,
      runner: { online: true, lastHeartbeatAt: 0, activeInstructionIds: [], activeSessionIds: [], version: null, tailnetUrl: null, claudeVersion: null, claudeAuth: "ok" },
    });
    expect(spy).toHaveBeenCalled();
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
}

describe("F3 接続", () => {
  it("つながったら購読（スレッドと指示）と presence を送る。見えなくなったら presence: false", () => {
    const qc = makeQc();
    const sock = new FakeSocket();
    const rt = new Realtime({ qc, url: "ws://x", createSocket: () => sock });
    rt.subscribe({ threadId: COO_THREAD_ID, instructionId: "i1" });
    rt.start();
    sock.open();
    const msgs = sock.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s));
    expect(msgs).toContainEqual({ t: "subscribe", threadId: COO_THREAD_ID, instructionId: "i1" });
    expect(msgs).toContainEqual({ t: "presence", visible: true });
    rt.setPresence(false);
    expect(JSON.parse(sock.sent[sock.sent.length - 1]!)).toEqual({ t: "presence", visible: false });
    rt.subscribe({ threadId: null, instructionId: null });
    expect(JSON.parse(sock.sent[sock.sent.length - 1]!)).toEqual({ t: "unsubscribe" });
    rt.stop();
  });

  it("届いた束（batch）を開いて全部反映する", () => {
    const qc = makeQc();
    const sock = new FakeSocket();
    const rt = new Realtime({ qc, url: "ws://x", createSocket: () => sock });
    seedList(qc, [summary({ id: "a", status: "running", updatedAt: 1 })]);
    rt.start();
    sock.open();
    const a = qc.getQueryData<ListInstructionsOutput>(qk.list("active"))!.items[0]!;
    sock.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ t: "batch", items: [{ t: "instruction.upserted", instruction: { ...a, status: "review", updatedAt: 5 } }] }) }));
    expect(qc.getQueryData<ListInstructionsOutput>(qk.list("active"))!.items[0]!.status).toBe("review");
    rt.stop();
  });

  it("再接続の待ち時間は 1 → 2 → 4 … 最大 30 秒", () => {
    expect([0, 1, 2, 10].map(backoffDelay)).toEqual([1000, 2000, 4000, 30000]);
  });
});
