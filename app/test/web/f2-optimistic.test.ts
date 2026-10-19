// F2 楽観的送信と、サーバーの応答での置き換え（重複しない）。オフラインは送信待ち、失敗は再送（13.5）
import { beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, COO_THREAD_ID, type ListMessagesOutput } from "@baton/shared";
import { qk } from "../../src/web/api/keys.ts";
import { deliver, mergeOutbox, sendToThread } from "../../src/web/api/messages.ts";
import { useOutbox, type OutboxItem } from "../../src/web/state/outbox.ts";
import { useToasts } from "../../src/web/state/toasts.ts";
import { deferred, json, makeQc, message, recordingTransport } from "./helpers.tsx";

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useOutbox.setState({ items: {} });
  useToasts.setState({ toast: null });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

describe("F2 楽観的送信", () => {
  it("送信待ちはサーバーの発言の後ろに混ざり、同じ clientId が届いたら消える", () => {
    const outbox: OutboxItem[] = [
      { clientId: "c1", target: { kind: "thread", threadId: COO_THREAD_ID }, body: "一つ目", createdAt: 1, state: "sending" },
      { clientId: "c2", target: { kind: "thread", threadId: COO_THREAD_ID }, body: "二つ目", createdAt: 2, state: "failed" },
      { clientId: "c3", target: { kind: "thread", threadId: "other" }, body: "別のスレッド", createdAt: 3, state: "sending" },
    ];
    const server = [message({ seq: 5 }), message({ seq: 6, authorKind: "ceo", clientId: "c1", body: "一つ目" })];
    const { items, delivered } = mergeOutbox(server, outbox, COO_THREAD_ID);
    expect(delivered).toEqual(["c1"]);
    expect(items.map((m) => m.body)).toEqual([server[0]!.body, "一つ目", "二つ目"]);
    const local = items[2]!;
    expect(local.local).toBe("failed");
    expect(local.authorKind).toBe("ceo");
    expect(local.seq).toBeGreaterThan(6);
  });

  it("送ると送信待ちに入り、応答の発言をキャッシュに入れて送信待ちから外す（二重にならない）", async () => {
    const qc = makeQc();
    qc.setQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID), { items: [], hasMoreBefore: false });
    const gate = deferred<void>();
    const { calls } = recordingTransport(async (call) => {
      await gate.promise;
      return json(201, { message: message({ seq: 9, authorKind: "ceo", clientId: (call.body as { clientId: string }).clientId, body: "台本を作りたい" }) });
    });
    const clientId = sendToThread(qc, COO_THREAD_ID, "  台本を作りたい  ", { contextProjectId: "p1" })!;
    expect(useOutbox.getState().items[clientId]?.state).toBe("sending");
    expect(useOutbox.getState().items[clientId]?.body).toBe("台本を作りたい");
    gate.resolve();
    await tick();
    await tick();
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(API_PATHS.threadMessages(COO_THREAD_ID));
    expect(calls[0]!.body).toMatchObject({ clientId, body: "台本を作りたい", contextProjectId: "p1" });
    expect(useOutbox.getState().items[clientId]).toBeUndefined();
    const cached = qc.getQueryData<ListMessagesOutput>(qk.messages(COO_THREAD_ID))!.items;
    expect(cached.filter((m) => m.clientId === clientId)).toHaveLength(1);
  });

  it("空白だけ・長すぎは送らない", () => {
    const qc = makeQc();
    recordingTransport(() => json(500, {}));
    expect(sendToThread(qc, COO_THREAD_ID, "   ")).toBeNull();
    expect(sendToThread(qc, COO_THREAD_ID, "あ".repeat(8001))).toBeNull();
    expect(Object.keys(useOutbox.getState().items)).toHaveLength(0);
  });

  it("失敗したら failed と再送のトースト。再送は同じ clientId で送る", async () => {
    const qc = makeQc();
    let fail = true;
    const { calls } = recordingTransport(() => (fail ? json(500, { error: { code: "internal", message: "x" } }) : json(201, { message: message({ authorKind: "ceo" }) })));
    const clientId = sendToThread(qc, COO_THREAD_ID, "送れないかも")!;
    await tick();
    await tick();
    expect(useOutbox.getState().items[clientId]?.state).toBe("failed");
    expect(useToasts.getState().toast?.kind).toBe("sendFailed");
    fail = false;
    await deliver(qc, clientId);
    expect(calls.map((c) => (c.body as { clientId: string }).clientId)).toEqual([clientId, clientId]);
    expect(useOutbox.getState().items[clientId]).toBeUndefined();
  });

  it("オフラインのときは送らずに送信待ち", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    const qc = makeQc();
    const { calls } = recordingTransport(() => json(201, {}));
    const clientId = sendToThread(qc, COO_THREAD_ID, "あとで")!;
    expect(useOutbox.getState().items[clientId]?.state).toBe("waiting");
    expect(calls).toHaveLength(0);
  });
});
