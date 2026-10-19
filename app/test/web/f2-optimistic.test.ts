// F2 楽観的作成と、サーバー応答での置き換え（重複しない）
import { beforeEach, describe, expect, it } from "vitest";
import type { InstructionSummary } from "@baton/shared";
import { deliver, mergeOutbox, submitInstruction } from "../../src/web/api/actions.ts";
import { upsertInstruction } from "../../src/web/api/cache.ts";
import { useOutbox } from "../../src/web/state/outbox.ts";
import { deferred, json, listItems, makeQc, recordingTransport, seedList, summary } from "./helpers.tsx";

beforeEach(() => {
  useOutbox.setState({ items: {} });
});

describe("F2 楽観的作成", () => {
  it("送るとすぐ一覧の待機に差し込み、サーバーの応答で置き換える（1 件のまま）", async () => {
    const qc = makeQc();
    const existing = summary({ status: "running" });
    seedList(qc, [existing]);
    const gate = deferred<Response>();
    const { calls } = recordingTransport(() => gate.promise);

    const clientId = submitInstruction(qc, "  競合の料金を調べて  ")!;
    expect(clientId).toMatch(/[0-9a-f-]{36}/);
    const optimistic = listItems(qc).find((i) => i.clientId === clientId)!;
    expect(optimistic).toMatchObject({ id: clientId, status: "queued", body: "競合の料金を調べて" });
    expect(listItems(qc)).toHaveLength(2);
    expect(useOutbox.getState().items[clientId]?.state).toBe("sending");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/instructions", body: { clientId, body: "競合の料金を調べて" } });
    expect(calls[0]!.headers.get("X-Baton-CSRF")).toBe("csrf-test");

    const server: InstructionSummary = summary({ id: "srv-1", clientId, body: "競合の料金を調べて", status: "queued" });
    gate.resolve(json(201, server));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const after = listItems(qc).filter((i) => i.clientId === clientId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe("srv-1");
    expect(listItems(qc)).toHaveLength(2);
    expect(useOutbox.getState().items[clientId]).toBeUndefined();
  });

  it("WebSocket のイベントが応答より先に届いても重複しない", async () => {
    const qc = makeQc();
    seedList(qc, []);
    const gate = deferred<Response>();
    recordingTransport(() => gate.promise);
    const clientId = submitInstruction(qc, "先に WS が来る")!;
    const server = summary({ id: "srv-2", clientId, body: "先に WS が来る" });
    upsertInstruction(qc, server); // instruction.upserted
    expect(listItems(qc).map((i) => i.id)).toEqual(["srv-2"]);
    gate.resolve(json(201, server));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(listItems(qc).map((i) => i.id)).toEqual(["srv-2"]);
  });

  it("空白だけは送らない", () => {
    const qc = makeQc();
    seedList(qc, []);
    const { calls } = recordingTransport(() => json(201, {}));
    expect(submitInstruction(qc, "  \n\t ")).toBeNull();
    expect(listItems(qc)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("一覧を取り直しても、まだ届いていない楽観的な行は消えない", () => {
    useOutbox.getState().put({ clientId: "c-pending", body: "送信待ち", createdAt: 1, state: "waiting" });
    const merged = mergeOutbox({ items: [summary({ clientId: "c-other" })], nextCursor: null });
    expect(merged.items.map((i) => i.clientId)).toEqual(["c-pending", "c-other"]);
    // サーバーに届いていた分は送信待ちから外れる
    const merged2 = mergeOutbox({ items: [summary({ clientId: "c-pending" })], nextCursor: null });
    expect(merged2.items).toHaveLength(1);
    expect(useOutbox.getState().items["c-pending"]).toBeUndefined();
  });

  it("失敗したら failed にし、同じ clientId で再送できる", async () => {
    const qc = makeQc();
    seedList(qc, []);
    let fail = true;
    const { calls } = recordingTransport((c) => (fail ? json(500, { error: { code: "internal", message: "x" } }) : json(201, summary({ id: "srv-3", clientId: (c.body as { clientId: string }).clientId }))));
    const clientId = submitInstruction(qc, "失敗する")!;
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(useOutbox.getState().items[clientId]?.state).toBe("failed");
    fail = false;
    await deliver(qc, clientId);
    expect(calls.map((c) => (c.body as { clientId: string }).clientId)).toEqual([clientId, clientId]);
    expect(listItems(qc).map((i) => i.id)).toEqual(["srv-3"]);
  });
});
