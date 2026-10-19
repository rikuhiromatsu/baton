// F3 WebSocket のイベントでクエリキャッシュが更新される。hello で全部取り直す
import { describe, expect, it, vi } from "vitest";
import type { InstructionDetail, ServerEvent, Task } from "@baton/shared";
import { qk } from "../../src/web/api/keys.ts";
import { Realtime, backoffDelay, type SocketLike } from "../../src/web/api/ws.ts";
import { listItems, makeQc, seedList, summary } from "./helpers.tsx";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

function task(over: Partial<Task>): Task {
  return {
    id: "t1",
    instructionId: "i1",
    parentTaskId: null,
    assigneeAgentId: null,
    kind: "work",
    planKey: "t1",
    dependsOn: [],
    title: "作業",
    spec: "",
    status: "pending",
    resultSummary: null,
    round: 1,
    seq: 0,
    startedAt: null,
    finishedAt: null,
    updatedAt: 1,
    ...over,
  };
}

function setup() {
  FakeSocket.all = [];
  const qc = makeQc();
  const rt = new Realtime({ qc, url: "ws://test/api/ws", createSocket: (u) => new FakeSocket(u) });
  rt.start();
  const sock = FakeSocket.all[0]!;
  sock.open();
  return { qc, rt, sock };
}

describe("F3 WebSocket → キャッシュ", () => {
  it("instruction.upserted で一覧と詳細が更新される（古いイベントは無視）", () => {
    const { qc, rt, sock } = setup();
    const a = summary({ id: "i1", status: "queued", updatedAt: 10 });
    seedList(qc, [a]);
    qc.setQueryData<InstructionDetail>(qk.detail("i1"), {
      instruction: { ...a, feedback: null, tokensIn: 0, tokensOut: 0, attempt: 0 },
      project: null,
      tasks: [],
      decisions: [],
      artifacts: [],
      lastEventSeq: -1,
    });
    sock.emit({ t: "instruction.upserted", instruction: { ...a, status: "running", updatedAt: 20 } });
    expect(listItems(qc)[0]!.status).toBe("running");
    expect(qc.getQueryData<InstructionDetail>(qk.detail("i1"))!.instruction.status).toBe("running");
    sock.emit({ t: "instruction.upserted", instruction: { ...a, status: "queued", updatedAt: 15 } });
    expect(listItems(qc)[0]!.status).toBe("running");
    // アーカイブされたら active から消える
    sock.emit({ t: "instruction.upserted", instruction: { ...a, status: "archived", updatedAt: 30 } });
    expect(listItems(qc)).toHaveLength(0);
    rt.stop();
  });

  it("task.upserted で詳細のタスクと一覧のタスク数が更新される。batch も開く", () => {
    const { qc, rt, sock } = setup();
    const a = summary({ id: "i1", status: "running" });
    seedList(qc, [a]);
    qc.setQueryData<InstructionDetail>(qk.detail("i1"), {
      instruction: { ...a, feedback: null, tokensIn: 0, tokensOut: 0, attempt: 1 },
      project: null,
      tasks: [],
      decisions: [],
      artifacts: [],
      lastEventSeq: -1,
    });
    const events: ServerEvent[] = [
      { t: "task.upserted", task: task({ id: "t1", status: "running" }) },
      { t: "task.upserted", task: task({ id: "t2", status: "pending", seq: 1 }) },
    ];
    sock.emit({ t: "batch", items: events });
    sock.emit({ t: "task.upserted", task: task({ id: "t1", status: "done", updatedAt: 2 }) });
    const d = qc.getQueryData<InstructionDetail>(qk.detail("i1"))!;
    expect(d.tasks.map((t) => [t.id, t.status])).toEqual([
      ["t1", "done"],
      ["t2", "pending"],
    ]);
    expect(listItems(qc)[0]!.taskCounts).toEqual({ total: 2, done: 1, running: 0, failed: 0 });
    rt.stop();
  });

  it("詳細を持っていなくても、一覧のタスク数は差分で動く", () => {
    const { qc, rt, sock } = setup();
    seedList(qc, [summary({ id: "i9", status: "running" })]);
    sock.emit({ t: "task.upserted", task: task({ id: "x1", instructionId: "i9", status: "running" }) });
    sock.emit({ t: "task.upserted", task: task({ id: "x1", instructionId: "i9", status: "done" }) });
    expect(listItems(qc)[0]!.taskCounts).toEqual({ total: 1, done: 1, running: 0, failed: 0 });
    rt.stop();
  });

  it("hello を受けたら表示中のクエリを全部取り直す", () => {
    const { qc, rt, sock } = setup();
    const spy = vi.spyOn(qc, "invalidateQueries");
    sock.emit({ t: "hello", serverTime: 1, runner: { online: true, lastHeartbeatAt: 1, activeInstructionIds: [], version: "1", tailnetUrl: null } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ refetchType: "active" });
    rt.stop();
  });

  it("壊れたメッセージ・pong は無視する", () => {
    const { qc, rt, sock } = setup();
    seedList(qc, [summary({ id: "i1" })]);
    expect(() => {
      sock.emit("pong");
      sock.emit("{not json");
      sock.emit({ t: "unknown.event" });
    }).not.toThrow();
    expect(listItems(qc)).toHaveLength(1);
    rt.stop();
  });

  it("詳細を開いている間は subscribe、閉じたら unsubscribe。25 秒ごとに ping", () => {
    vi.useFakeTimers();
    const { rt, sock } = setup();
    rt.subscribe("i1");
    rt.subscribe(null);
    expect(sock.sent.map((s) => (s === "ping" ? s : JSON.parse(s)))).toEqual([{ t: "subscribe", instructionId: "i1" }, { t: "unsubscribe" }]);
    vi.advanceTimersByTime(25_000);
    expect(sock.sent.at(-1)).toBe("ping");
    rt.stop();
  });

  it("切れたら 1→2→4… 最大 30 秒でつなぎ直し、つながったら購読し直す", () => {
    vi.useFakeTimers();
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const { rt, sock } = setup();
    rt.subscribe("i1");
    sock.close();
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.close();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.open();
    expect(FakeSocket.all[2]!.sent.map((s) => JSON.parse(s))).toEqual([{ t: "subscribe", instructionId: "i1" }]);
    rt.stop();
  });
});
