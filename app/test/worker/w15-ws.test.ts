// W15 WebSocket（DO）: hello、instruction.upserted、購読した指示の agent_event.appended だけ、ping→pong、ランナーの接続・切断で runner.status、Origin 違いは拒否
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@baton/shared";
import { browser, call, clearQueue, createInstruction, login, openSocket, ORIGIN, registerRunner, runner, sleep, type TestSession } from "./helpers.ts";

const browserSocket = (s: TestSession) => openSocket("/api/ws", { Origin: ORIGIN, Cookie: s.cookie });

describe("W15 WebSocket", () => {
  it("接続直後に hello、指示の作成で instruction.upserted が届く", async () => {
    const s = await login();
    const ws = await browserSocket(s);
    const hello = await ws.waitFor<Extract<ServerEvent, { t: "hello" }>>((e) => e.t === "hello");
    expect(hello.runner).toMatchObject({ online: false });
    const inst = await createInstruction(s, "WS のテスト");
    const up = await ws.waitFor<Extract<ServerEvent, { t: "instruction.upserted" }>>((e) => e.t === "instruction.upserted" && e.instruction.id === inst.id);
    expect(up.instruction.status).toBe("queued");
    ws.close();
  });

  it("購読した指示の agent_event.appended だけ届く（content は 2KB に切る）", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearQueue();
    const a = await createInstruction(s, "購読する");
    await runner(r, "/api/runner/claim", { body: { maxConcurrent: 2, activeIds: [] } });
    const b = await createInstruction(s, "購読しない");
    await runner(r, "/api/runner/claim", { body: { maxConcurrent: 2, activeIds: [a.id] } });

    const sub = await browserSocket(s);
    const other = await browserSocket(s);
    await sub.waitFor((e) => e.t === "hello");
    await other.waitFor((e) => e.t === "hello");
    sub.ws.send(JSON.stringify({ t: "subscribe", instructionId: a.id }));
    other.ws.send(JSON.stringify({ t: "subscribe", instructionId: b.id }));
    await sleep(50);

    const ev = (seq: number, content: unknown) => ({ taskId: null, agentId: null, seq, kind: "note", content });
    await runner(r, "/api/runner/events", { body: { instructionId: a.id, events: [ev(0, "A のログ"), ev(1, "x".repeat(5000))] } });
    await runner(r, "/api/runner/events", { body: { instructionId: b.id, events: [ev(0, "B のログ")] } });

    const got = await sub.waitFor<Extract<ServerEvent, { t: "agent_event.appended" }>>((e) => e.t === "agent_event.appended" && e.event.seq === 1);
    expect(got.event.content).toMatchObject({ truncated: true });
    expect(JSON.stringify(got.event.content).length).toBeLessThan(2200);
    await other.waitFor((e) => e.t === "agent_event.appended");
    await sleep(250);
    const subIds = sub.events.filter((e) => e.t === "agent_event.appended").map((e) => (e as { event: { instructionId: string } }).event.instructionId);
    const otherIds = other.events.filter((e) => e.t === "agent_event.appended").map((e) => (e as { event: { instructionId: string } }).event.instructionId);
    expect(new Set(subIds)).toEqual(new Set([a.id]));
    expect(subIds).toHaveLength(2);
    expect(new Set(otherIds)).toEqual(new Set([b.id]));

    // 購読をやめたら届かない
    sub.ws.send(JSON.stringify({ t: "unsubscribe" }));
    await sleep(50);
    await runner(r, "/api/runner/events", { body: { instructionId: a.id, events: [ev(2, "もう届かない")] } });
    await sleep(250);
    expect(sub.events.filter((e) => e.t === "agent_event.appended")).toHaveLength(2);
    sub.close();
    other.close();
  });

  it("100ms 以内のイベントは batch で束ねて届く", async () => {
    const s = await login();
    const ws = await browserSocket(s);
    await ws.waitFor((e) => e.t === "hello");
    await Promise.all([createInstruction(s, "束ね 1"), createInstruction(s, "束ね 2"), createInstruction(s, "束ね 3")]);
    await ws.waitFor((e) => e.t === "instruction.upserted" && e.instruction.body === "束ね 3");
    await sleep(50);
    expect(ws.raw.some((m) => m.startsWith('{"t":"batch"'))).toBe(true);
    ws.close();
  });

  it("ログアウトしたセッションのソケットは閉じられ、以後は配信されない（Codex 指摘）", async () => {
    const s = await login();
    const other = await login();
    const ws = await browserSocket(s);
    const keep = await browserSocket(other);
    await ws.waitFor((e) => e.t === "hello");
    await keep.waitFor((e) => e.t === "hello");
    const closed = new Promise<number>((resolve) => ws.ws.addEventListener("close", (e) => resolve(e.code)));
    expect((await browser(s, "/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect(await closed).toBe(4401);
    // 別のセッションのソケットはそのまま届く
    const inst = await createInstruction(other, "ログアウト後の配信");
    await keep.waitFor((e) => e.t === "instruction.upserted" && e.instruction.id === inst.id);
    expect(ws.events.some((e) => e.t === "instruction.upserted" && e.instruction.id === inst.id)).toBe(false);
    keep.close();
  });

  it("ping に pong が返る", async () => {
    const s = await login();
    const ws = await browserSocket(s);
    await ws.waitFor((e) => e.t === "hello");
    ws.ws.send("ping");
    expect(await ws.waitForRaw((m) => m === "pong")).toBe("pong");
    ws.close();
  });

  it("ランナーが接続・切断すると runner.status（online → offline）", async () => {
    const s = await login();
    const r = await registerRunner();
    const b = await browserSocket(s);
    await b.waitFor((e) => e.t === "hello");
    const rs = await openSocket("/api/runner/ws", { Authorization: `Bearer ${r.token}` });
    expect(await rs.waitForRaw((m) => m.includes('"t":"hello"'))).toContain("serverTime");
    await b.waitFor((e) => e.t === "runner.status" && e.runner.online === true);
    // 指示を作るとランナーに work.available
    await createInstruction(s, "ランナーへの合図");
    expect(await rs.waitForRaw((m) => m.includes("work.available"))).toBe('{"t":"work.available"}');
    rs.close();
    await b.waitFor((e) => e.t === "runner.status" && e.runner.online === false);
    // 新しく接続したブラウザにも offline（ハートビートが来るまで）
    const b2 = await browserSocket(s);
    const hello = await b2.waitFor<Extract<ServerEvent, { t: "hello" }>>((e) => e.t === "hello");
    expect(hello.runner.online).toBe(false);
    b.close();
    b2.close();
  });

  it("取消でランナーに instruction.cancel、回答で decision.answered", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearQueue();
    const rs = await openSocket("/api/runner/ws", { Authorization: `Bearer ${r.token}` });
    await rs.waitForRaw((m) => m.includes('"t":"hello"'));
    const inst = await createInstruction(s, "取消の合図");
    await runner(r, "/api/runner/claim", { body: { maxConcurrent: 2, activeIds: [] } });
    const d = (await (await runner(r, "/api/runner/decisions", { body: { instructionId: inst.id, taskId: null, askedByAgentId: null, question: "q", options: [] } })).json()) as { id: string };
    const { browser } = await import("./helpers.ts");
    await browser(s, `/api/decisions/${d.id}/answer`, { body: { answer: "はい" } });
    expect(await rs.waitForRaw((m) => m.includes("decision.answered"))).toBe(JSON.stringify({ t: "decision.answered", instructionId: inst.id }));
    await browser(s, `/api/instructions/${inst.id}/transition`, { body: { action: "cancel", expectedStatus: "queued" } });
    expect(await rs.waitForRaw((m) => m.includes("instruction.cancel"))).toBe(JSON.stringify({ t: "instruction.cancel", instructionId: inst.id }));
    rs.close();
  });

  it("Origin 違い・Cookie 無し・Upgrade 無しは拒否。ランナー WS はトークン必須", async () => {
    const s = await login();
    const evil = await call("/api/ws", { headers: { Upgrade: "websocket", Origin: "https://evil.example.com", Cookie: s.cookie } });
    expect(evil.status).toBe(403);
    expect(evil.webSocket).toBeNull();
    expect((await call("/api/ws", { headers: { Upgrade: "websocket", Cookie: s.cookie } })).status).toBe(403);
    expect((await call("/api/ws", { headers: { Upgrade: "websocket", Origin: ORIGIN } })).status).toBe(401);
    expect((await call("/api/ws", { headers: { Origin: ORIGIN, Cookie: s.cookie } })).status).toBe(400);
    expect((await call("/api/runner/ws", { headers: { Upgrade: "websocket" } })).status).toBe(401);
  });
});
