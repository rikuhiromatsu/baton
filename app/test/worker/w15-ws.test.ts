// W15 WebSocket（DO）: hello、発言で message.upserted・thread.updated、購読した指示の transcript.appended だけ、batch、ログアウトで切断（D-35）、
// ping→pong、ランナーの接続・切断で runner.status、ランナーへの合図（work.available・thread.input・instruction.cancel・decision.answered）、
// session.upserted は 1 秒に 1 回まで、Origin 違いは拒否
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@baton/shared";
import {
  browser,
  call,
  claim,
  clearWork,
  createSession,
  login,
  membersInstruction,
  openSocket,
  ORIGIN,
  postCeo,
  registerRunner,
  runner,
  sleep,
  type TestSession,
} from "./helpers.ts";

const browserSocket = (s: TestSession) => openSocket("/api/ws", { Origin: ORIGIN, Cookie: s.cookie });

const transcriptItem = (sessionId: string, instructionId: string | null, seq: number, text: string, threadId: string | null = null) => ({
  id: crypto.randomUUID(), sessionId, threadId, instructionId, seq, kind: "text", author: "claude",
  toolName: null, toolUseId: null, parentToolUseId: null, summary: text.slice(0, 80), body: { text }, truncated: false, isError: false, createdAt: Date.now(),
});

describe("W15 WebSocket", () => {
  it("接続直後に hello、CEO の発言で message.upserted と thread.updated が届く", async () => {
    const s = await login();
    const ws = await browserSocket(s);
    const hello = await ws.waitFor<Extract<ServerEvent, { t: "hello" }>>((e) => e.t === "hello");
    expect(hello.runner).toMatchObject({ online: false });
    await postCeo(s, "thread-coo", "WS のテスト");
    const up = await ws.waitFor<Extract<ServerEvent, { t: "message.upserted" }>>((e) => e.t === "message.upserted" && e.message.body === "WS のテスト");
    expect(up.message).toMatchObject({ authorKind: "ceo", threadId: "thread-coo", status: "complete" });
    await ws.waitFor((e) => e.t === "thread.updated" && e.thread.id === "thread-coo");
    ws.close();
  });

  it("購読した指示の transcript.appended だけ届く（body は 2,000 文字に切る）", async () => {
    await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    const b = await membersInstruction(r);
    const sa = await createSession(r, { instructionId: a.id });
    const sb = await createSession(r, { instructionId: b.id });
    const s = await login();
    const sub = await browserSocket(s);
    const other = await browserSocket(s);
    await sub.waitFor((e) => e.t === "hello");
    await other.waitFor((e) => e.t === "hello");
    sub.ws.send(JSON.stringify({ t: "subscribe", instructionId: a.id }));
    other.ws.send(JSON.stringify({ t: "subscribe", instructionId: b.id }));
    await sleep(50);
    await runner(r, "/api/runner/transcript", { body: { items: [transcriptItem(sa, a.id, 0, "A"), transcriptItem(sa, a.id, 1, "x".repeat(5000))] } });
    await runner(r, "/api/runner/transcript", { body: { items: [transcriptItem(sb, b.id, 0, "B")] } });
    const got = await sub.waitFor<Extract<ServerEvent, { t: "transcript.appended" }>>((e) => e.t === "transcript.appended");
    expect(got.items.map((i) => i.seq)).toEqual([0, 1]);
    expect(got.items[1]!.truncated).toBe(true);
    expect((got.items[1]!.body.text as string).length).toBeLessThanOrEqual(2000);
    await other.waitFor((e) => e.t === "transcript.appended");
    await sleep(250);
    const ids = (sock: typeof sub) => sock.events.filter((e) => e.t === "transcript.appended").flatMap((e) => (e as Extract<ServerEvent, { t: "transcript.appended" }>).items.map((i) => i.instructionId));
    expect(new Set(ids(sub))).toEqual(new Set([a.id]));
    expect(new Set(ids(other))).toEqual(new Set([b.id]));
    // 購読をやめたら届かない
    sub.ws.send(JSON.stringify({ t: "unsubscribe" }));
    await sleep(50);
    await runner(r, "/api/runner/transcript", { body: { items: [transcriptItem(sa, a.id, 2, "もう届かない")] } });
    await sleep(250);
    expect(ids(sub)).toHaveLength(2);
    sub.close();
    other.close();
  });

  it("100ms 以内のイベントは batch で束ねて届く", async () => {
    const s = await login();
    const ws = await browserSocket(s);
    await ws.waitFor((e) => e.t === "hello");
    await Promise.all([postCeo(s, "thread-coo", "束ね 1"), postCeo(s, "thread-coo", "束ね 2")]);
    await ws.waitFor((e) => e.t === "message.upserted" && e.message.body === "束ね 2");
    await sleep(50);
    expect(ws.raw.some((m) => m.startsWith('{"t":"batch"'))).toBe(true);
    ws.close();
  });

  it("ログアウトしたセッションのソケットは閉じられ、以後は配信されない（D-35）", async () => {
    const s = await login();
    const other = await login();
    const ws = await browserSocket(s);
    const keep = await browserSocket(other);
    await ws.waitFor((e) => e.t === "hello");
    await keep.waitFor((e) => e.t === "hello");
    const closed = new Promise<number>((resolve) => ws.ws.addEventListener("close", (e) => resolve(e.code)));
    expect((await browser(s, "/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect(await closed).toBe(4401);
    await postCeo(other, "thread-coo", "ログアウト後の配信");
    await keep.waitFor((e) => e.t === "message.upserted" && e.message.body === "ログアウト後の配信");
    expect(ws.events.some((e) => e.t === "message.upserted" && e.message.body === "ログアウト後の配信")).toBe(false);
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

  it("ランナーが接続・切断すると runner.status。発言でランナーに work.available、ターン中なら thread.input", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const b = await browserSocket(s);
    await b.waitFor((e) => e.t === "hello");
    const rs = await openSocket("/api/runner/ws", { Authorization: `Bearer ${r.token}` });
    expect(await rs.waitForRaw((m) => m.includes('"t":"hello"'))).toContain("serverTime");
    await b.waitFor((e) => e.t === "runner.status" && e.runner.online === true);
    await postCeo(s, "thread-coo", "ランナーへの合図");
    expect(await rs.waitForRaw((m) => m.includes("work.available"))).toBe('{"t":"work.available"}');
    expect((await claim(r, ["thread"])).status).toBe(200);
    await postCeo(s, "thread-coo", "ターン中の追加");
    const input = JSON.parse(await rs.waitForRaw((m) => m.includes("thread.input"))) as { t: string; threadId: string; inboxId: string };
    expect(input).toMatchObject({ t: "thread.input", threadId: "thread-coo" });
    expect(input.inboxId).toBeTruthy();
    rs.close();
    await b.waitFor((e) => e.t === "runner.status" && e.runner.online === false);
    const b2 = await browserSocket(s);
    const hello = await b2.waitFor<Extract<ServerEvent, { t: "hello" }>>((e) => e.t === "hello");
    expect(hello.runner.online).toBe(false);
    b.close();
    b2.close();
  });

  it("取消でランナーに instruction.cancel、回答で decision.answered（decisionId・sessionId 付き）", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const rs = await openSocket("/api/runner/ws", { Authorization: `Bearer ${r.token}` });
    await rs.waitForRaw((m) => m.includes('"t":"hello"'));
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sessionId = await createSession(r, { instructionId: a.id });
    const d = (await (await runner(r, "/api/runner/approvals", {
      body: { id: crypto.randomUUID(), instructionId: a.id, sessionId, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: { command: "npm install zod" }, toolUseId: "tu1", question: "npm install zod を実行してよいですか" },
    })).json()) as { id: string };
    await browser(s, `/api/decisions/${d.id}/answer`, { body: { verdict: "allow" } });
    expect(JSON.parse(await rs.waitForRaw((m) => m.includes("decision.answered")))).toEqual({ t: "decision.answered", decisionId: d.id, sessionId, instructionId: a.id });
    await browser(s, `/api/instructions/${a.id}/transition`, { body: { action: "cancel", expectedStatus: "running" } });
    expect(await rs.waitForRaw((m) => m.includes("instruction.cancel"))).toBe(JSON.stringify({ t: "instruction.cancel", instructionId: a.id }));
    rs.close();
  });

  it("session.upserted は同じセッションで 1 秒に 1 回まで（最後の値は遅れて届く）", async () => {
    const s = await login();
    const r = await registerRunner();
    const ws = await browserSocket(s);
    await ws.waitFor((e) => e.t === "hello");
    const id = await createSession(r, { threadId: "thread-coo", role: "coo" });
    for (const activity of ["読んでいる a", "読んでいる b", "読んでいる c"]) {
      await runner(r, `/api/runner/sessions/${id}`, { method: "PATCH", body: { activity } });
    }
    await sleep(300);
    const early = ws.events.filter((e) => e.t === "session.upserted" && e.session.id === id);
    expect(early.length).toBeLessThanOrEqual(1);
    const last = await ws.waitFor<Extract<ServerEvent, { t: "session.upserted" }>>((e) => e.t === "session.upserted" && e.session.id === id && e.session.activity === "読んでいる c", 2500);
    expect(last.session.activity).toBe("読んでいる c");
    ws.close();
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
