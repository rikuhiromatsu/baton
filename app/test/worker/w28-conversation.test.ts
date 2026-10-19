// W28 プロジェクト案、W29 delegate（ランナーがプロジェクト・指示・依頼を作る）、W30 発言、W31 ストリーム、W32 既読・未読、
// W33 claim（スレッド）、W34 版、W35 差し戻し（DESIGN-v2 3〜4 章・5.4・12.2・12.3）
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ClaimOutput,
  type InstructionSummary,
  type ProjectProposal,
  type ProjectWithTeam,
  type ServerEvent,
  type ThreadMessage,
  type ThreadSummary,
} from "@baton/shared";
import {
  browser,
  claim,
  clearWork,
  createProject,
  createSession,
  insertInstruction,
  login,
  openSocket,
  ORIGIN,
  postCeo,
  registerRunner,
  runner,
  runnerCreateInstruction,
  sleep,
  statusOf,
  type TestRunner,
  type TestSession,
} from "./helpers.ts";

async function agentMessage(r: TestRunner, threadId: string, fields: Record<string, unknown> = {}) {
  const res = await runner(r, `/api/runner/threads/${threadId}/messages`, {
    body: { id: crypto.randomUUID(), authorKind: "coo", authorAgentId: null, kind: "chat", body: "COO の返事", instructionId: null, sessionId: null, ref: {}, status: "complete", notify: true, ...fields },
  });
  if (res.status !== 201) throw new Error(`message ${res.status} ${await res.text()}`);
  return ((await res.json()) as { message: ThreadMessage }).message;
}

async function threadOf(s: TestSession, id: string): Promise<ThreadSummary> {
  const { items } = (await (await browser(s, "/api/threads")).json()) as { items: ThreadSummary[] };
  return items.find((t) => t.id === id)!;
}

async function claimThread(r: TestRunner) {
  const res = await claim(r, ["thread"]);
  if (res.status !== 200) throw new Error(`claim ${res.status}`);
  const out = ClaimOutput.parse(await res.json());
  if (out.kind !== "thread") throw new Error("kind");
  return out;
}

const proposalBody = (threadId: string, fields: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  threadId,
  messageId: null,
  name: "ショート動画台本",
  slug: `shorts-${crypto.randomUUID().slice(0, 6)}`,
  goal: "コーヒー紹介の台本を 10 本",
  summary: "台本",
  workspace: { kind: "baton" },
  leader: { name: "リーダー", specialty: "台本" },
  members: [{ name: "リサーチ", specialty: "調べる", profile: "researcher" }],
  ...fields,
});

describe("W28 プロジェクト案", () => {
  it("立てるとプロジェクト・チーム・リーダーのスレッド・COO の受信箱（project_created）。二重の立てるは 409", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const msg = await agentMessage(r, "thread-coo", { body: "こういうプロジェクトはどうでしょう" });
    const body = proposalBody("thread-coo", { messageId: msg.id });
    const created = await runner(r, "/api/runner/project-proposals", { body });
    expect(created.status).toBe(201);
    expect(((await runner(r, "/api/runner/project-proposals", { body })).status)).toBe(200);
    expect((await env.DB.prepare("SELECT kind, json_extract(ref, '$.proposalId') AS p FROM thread_messages WHERE id = ?").bind(msg.id).first())).toEqual({ kind: "project_proposal", p: body.id });
    const res = await browser(s, `/api/project-proposals/${body.id}/accept`, { body: {} });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { project: ProjectWithTeam; proposal: ProjectProposal };
    expect(out.proposal).toMatchObject({ status: "accepted", projectId: out.project.id });
    expect(out.project).toMatchObject({ name: "ショート動画台本", goal: "コーヒー紹介の台本を 10 本", workspaceKind: "baton" });
    expect(out.project.agents.map((a) => [a.role, a.name, a.profile])).toEqual([["leader", "リーダー", "leader"], ["member", "リサーチ", "researcher"]]);
    expect((await env.DB.prepare("SELECT kind, agent_id FROM threads WHERE project_id = ?").bind(out.project.id).first())).toEqual({ kind: "leader", agent_id: out.project.agents[0]!.id });
    const inbox = await env.DB.prepare("SELECT kind, wakes, status FROM thread_inbox WHERE thread_id = 'thread-coo' AND kind = 'project_created' AND json_extract(payload, '$.projectId') = ?").bind(out.project.id).first();
    expect(inbox).toEqual({ kind: "project_created", wakes: 1, status: "pending" });
    expect((await browser(s, `/api/project-proposals/${body.id}/accept`, { body: {} })).status).toBe(409);
  });

  it("作業場所を選び直せる（候補外の repoPath は 400）。見送りは COO に知らせるだけ。同じ slug の古い案は置き換え", async () => {
    const s = await login();
    const r = await registerRunner();
    const repo = `/Users/x/projects/${crypto.randomUUID().slice(0, 6)}/sample-repo`;
    await runner(r, "/api/runner/repos", { method: "PUT", body: { items: [{ path: repo, name: "x/sample-repo", defaultBranch: "main", headSha: null, lastCommitAt: null, dirty: false }] } });
    expect((await runner(r, "/api/runner/project-proposals", { body: proposalBody("thread-coo", { workspace: { kind: "repo", repoPath: "/nope" } }) })).status).toBe(400);
    const a = proposalBody("thread-coo");
    await runner(r, "/api/runner/project-proposals", { body: a });
    expect((await browser(s, `/api/project-proposals/${a.id}/accept`, { body: { workspace: { kind: "repo", repoPath: "/nope" } } })).status).toBe(400);
    const ok = (await (await browser(s, `/api/project-proposals/${a.id}/accept`, { body: { workspace: { kind: "repo", repoPath: repo } } })).json()) as { project: ProjectWithTeam };
    expect(ok.project).toMatchObject({ workspaceKind: "repo", repoPath: repo, repoName: "x/sample-repo" });

    const b1 = proposalBody("thread-coo", { slug: "same-slug" });
    await runner(r, "/api/runner/project-proposals", { body: b1 });
    const b2 = { ...proposalBody("thread-coo"), slug: "same-slug" };
    await runner(r, "/api/runner/project-proposals", { body: b2 });
    expect((await env.DB.prepare("SELECT status FROM project_proposals WHERE id = ?").bind(b1.id).first())?.status).toBe("superseded");
    expect((await browser(s, `/api/project-proposals/${b2.id}/decline`, { method: "POST" })).status).toBe(204);
    expect((await browser(s, `/api/project-proposals/${b2.id}/decline`, { method: "POST" })).status).toBe(409);
    const note = await env.DB.prepare("SELECT wakes FROM thread_inbox WHERE json_extract(payload, '$.proposalId') = ? AND kind = 'instruction_event'").bind(b2.id).first();
    expect(note).toEqual({ wakes: 0 });
    expect((await browser(s, `/api/project-proposals/${crypto.randomUUID()}/accept`, { body: {} })).status).toBe(404);
  });
});

describe("W29 delegate（ランナーが立てる・振る）", () => {
  it("Baton 専用のプロジェクトをその場で立て（slug が重なれば -2）、指示を作る（冪等、created_by は CEO、本文は依頼）", async () => {
    const s = await login();
    const r = await registerRunner();
    const slug = `dup-${crypto.randomUUID().slice(0, 6)}`;
    const p1 = await createProject(r, slug);
    const p2 = await createProject(r, slug);
    expect(p2.project.slug).toBe(`${slug}-2`);
    expect(p1.leaderThreadId).toBe(`thread-${p1.project.id}`);
    const id = crypto.randomUUID();
    const body = { id, title: "台本 10 本", body: "[CEO] コーヒー紹介の台本を 10 本", projectId: p1.project.id, originThreadId: "thread-coo", originMessageId: null, phase: "leader" };
    const res = await runner(r, "/api/runner/instructions", { body });
    expect(res.status).toBe(201);
    const inst = (await res.json()) as InstructionSummary;
    expect(inst).toMatchObject({ id, status: "queued", phase: "leader", revision: 1, title: "台本 10 本", body: "[CEO] コーヒー紹介の台本を 10 本", projectId: p1.project.id });
    expect((await runner(r, "/api/runner/instructions", { body })).status).toBe(200);
    expect((await env.DB.prepare("SELECT created_by, origin_thread_id FROM instructions WHERE id = ?").bind(id).first())).toEqual({ created_by: s.userId, origin_thread_id: "thread-coo" });
    expect((await runner(r, "/api/runner/instructions", { body: { ...body, id: crypto.randomUUID(), projectId: crypto.randomUUID() } })).status).toBe(400);
    // リーダーの受信箱へ依頼（COO → リーダー）。リーダーのスレッドが queued になる
    const ib = await runner(r, `/api/runner/threads/${p1.leaderThreadId}/inbox`, { body: { kind: "delegation", wakes: true, instructionId: id, payload: { body: "台本を 10 本" } } });
    expect(ib.status).toBe(201);
    expect((await env.DB.prepare("SELECT status FROM threads WHERE id = ?").bind(p1.leaderThreadId).first())?.status).toBe("queued");
    // queued → running（リーダーのターンが始まる）
    const run = await runner(r, `/api/runner/instructions/${id}`, { method: "PATCH", body: { status: "running" } });
    expect(run.status).toBe(200);
    expect((await runner(r, `/api/runner/instructions/${id}`, { method: "PATCH", body: { status: "done" } })).status).toBe(400);
  });
});

describe("W30 発言", () => {
  it("CEO の発言は clientId で冪等、受信箱へ、スレッドが queued、返事待ちが外れる。本文 8001 文字は 400。他スレッドの指示は 400", async () => {
    const s = await login();
    await clearWork();
    await env.DB.prepare("UPDATE threads SET awaiting_reply = 1 WHERE id = 'thread-coo'").run();
    const clientId = crypto.randomUUID();
    const res = await postCeo(s, "thread-coo", "ショート動画の台本 10 本作りたい", { clientId });
    expect(res.status).toBe(201);
    const { message } = (await res.json()) as { message: ThreadMessage };
    expect(message).toMatchObject({ authorKind: "ceo", kind: "chat", status: "complete", notify: false, clientId, authorName: "CEO" });
    const again = await postCeo(s, "thread-coo", "ショート動画の台本 10 本作りたい", { clientId });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { message: ThreadMessage }).message.id).toBe(message.id);
    const t = await threadOf(s, "thread-coo");
    expect(t).toMatchObject({ status: "queued", awaitingReply: false, lastSeq: message.seq, lastReadSeq: message.seq });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE message_id = ?").bind(message.id).first())?.n).toBe(1);
    expect((await postCeo(s, "thread-coo", "x".repeat(8001))).status).toBe(400);
    expect((await postCeo(s, "thread-coo", "x", { instructionId: crypto.randomUUID() })).status).toBe(400);
    expect((await postCeo(s, "thread-nope", "x")).status).toBe(404);
  });

  it("ランナーの発言: 採番、名前、notify は COO・リーダーの chat・report・proposal だけ。PATCH で完成・空なら消す", async () => {
    const s = await login();
    const r = await registerRunner();
    const p = await createProject(r);
    const coo = await agentMessage(r, "thread-coo");
    expect(coo).toMatchObject({ authorKind: "coo", authorAgentId: "agent-coo", authorName: "COO", notify: true });
    const leader = await agentMessage(r, p.leaderThreadId, { authorKind: "leader" });
    expect(leader).toMatchObject({ authorName: "リーダー", authorAgentId: p.leaderId, seq: 1 });
    const notice = await agentMessage(r, "thread-coo", { authorKind: "system", kind: "notice", notify: true });
    expect(notice.notify).toBe(false);
    const report = await agentMessage(r, "thread-coo", { authorKind: "leader", kind: "leader_report", notify: true, authorAgentId: p.leaderId });
    expect(report.notify).toBe(false);
    const streaming = await agentMessage(r, "thread-coo", { status: "streaming", body: "" });
    expect(streaming.status).toBe("streaming");
    const patched = await runner(r, `/api/runner/threads/thread-coo/messages/${streaming.id}`, { method: "PATCH", body: { body: "なんの動画ですか？", status: "complete" } });
    expect(((await patched.json()) as { message: ThreadMessage }).message).toMatchObject({ body: "なんの動画ですか？", status: "complete" });
    const empty = await agentMessage(r, "thread-coo", { status: "streaming", body: "" });
    expect((await runner(r, `/api/runner/threads/thread-coo/messages/${empty.id}`, { method: "PATCH", body: { delete: true } })).status).toBe(204);
    const list = (await (await browser(s, "/api/threads/thread-coo/messages?limit=100")).json()) as { items: ThreadMessage[] };
    expect(list.items.some((m) => m.id === empty.id)).toBe(false);
    // CEO の発言は書き換えられない
    const ceo = ((await (await postCeo(s, "thread-coo", "書き換え禁止")).json()) as { message: ThreadMessage }).message;
    expect((await runner(r, `/api/runner/threads/thread-coo/messages/${ceo.id}`, { method: "PATCH", body: { body: "x" } })).status).toBe(409);
  });

  it("一覧は最新 limit 件を古い順、before で前へ", async () => {
    const s = await login();
    const r = await registerRunner();
    const p = await createProject(r);
    for (let n = 0; n < 5; n++) await agentMessage(r, p.leaderThreadId, { authorKind: "leader", body: `m${n}` });
    const page = (await (await browser(s, `/api/threads/${p.leaderThreadId}/messages?limit=2`)).json()) as { items: ThreadMessage[]; hasMoreBefore: boolean };
    expect(page.items.map((m) => m.body)).toEqual(["m3", "m4"]);
    expect(page.hasMoreBefore).toBe(true);
    const prev = (await (await browser(s, `/api/threads/${p.leaderThreadId}/messages?before=${page.items[0]!.seq}&limit=10`)).json()) as { items: ThreadMessage[]; hasMoreBefore: boolean };
    expect(prev.items.map((m) => m.body)).toEqual(["m0", "m1", "m2"]);
    expect(prev.hasMoreBefore).toBe(false);
  });

  it("新しい話題: 区切りの知らせ、次は新しいセッション", async () => {
    const s = await login();
    const r = await registerRunner();
    await createSession(r, { threadId: "thread-coo", role: "coo" });
    const res = await browser(s, "/api/threads/thread-coo/reset", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: ThreadMessage }).message).toMatchObject({ kind: "notice", authorKind: "system", body: "新しい話題" });
    expect((await env.DB.prepare("SELECT current_session_id FROM threads WHERE id = 'thread-coo'").first())?.current_session_id).toBeNull();
  });
});

describe("W31 ストリーム", () => {
  it("message.delta はそのスレッドを開いているブラウザにだけ届き、D1 には書かない", async () => {
    const s = await login();
    const r = await registerRunner();
    const open = await openSocket("/api/ws", { Origin: ORIGIN, Cookie: s.cookie });
    const closed = await openSocket("/api/ws", { Origin: ORIGIN, Cookie: s.cookie });
    await open.waitFor((e) => e.t === "hello");
    await closed.waitFor((e) => e.t === "hello");
    open.ws.send(JSON.stringify({ t: "subscribe", threadId: "thread-coo" }));
    await sleep(50);
    const m = await agentMessage(r, "thread-coo", { status: "streaming", body: "" });
    expect((await runner(r, "/api/runner/threads/thread-coo/stream", { body: { messageId: m.id, offset: 0, delta: "なんの", activity: "返事を書いている" } })).status).toBe(204);
    expect((await runner(r, "/api/runner/threads/thread-coo/stream", { body: { messageId: m.id, offset: 3, delta: "動画", reset: false } })).status).toBe(204);
    const d = await open.waitFor<Extract<ServerEvent, { t: "message.delta" }>>((e) => e.t === "message.delta" && e.offset === 3);
    expect(d).toMatchObject({ threadId: "thread-coo", messageId: m.id, delta: "動画" });
    expect(open.events.find((e) => e.t === "message.delta" && e.offset === 0)).toMatchObject({ activity: "返事を書いている" });
    await sleep(200);
    expect(closed.events.some((e) => e.t === "message.delta")).toBe(false);
    expect((await env.DB.prepare("SELECT body FROM thread_messages WHERE id = ?").bind(m.id).first())?.body).toBe("");
    expect((await runner(r, "/api/runner/threads/thread-coo/stream", { body: { messageId: m.id, offset: 0, delta: "x".repeat(4001) } })).status).toBe(400);
    open.close();
    closed.close();
  });
});

describe("W32 既読・未読", () => {
  it("notify=1 の完成した発言だけ数え、既読で 0。既読は進むだけ・last_seq で頭打ち", async () => {
    const s = await login();
    const r = await registerRunner();
    const p = await createProject(r);
    await agentMessage(r, p.leaderThreadId, { authorKind: "leader", notify: true });
    await agentMessage(r, p.leaderThreadId, { authorKind: "leader", notify: false });
    await agentMessage(r, p.leaderThreadId, { authorKind: "leader", notify: true, status: "streaming" });
    const last = await agentMessage(r, p.leaderThreadId, { authorKind: "leader", notify: true });
    expect((await threadOf(s, p.leaderThreadId)).unread).toBe(2);
    expect((await browser(s, `/api/threads/${p.leaderThreadId}/read`, { body: { seq: last.seq - 1 } })).status).toBe(204);
    expect((await threadOf(s, p.leaderThreadId)).unread).toBe(1);
    await browser(s, `/api/threads/${p.leaderThreadId}/read`, { body: { seq: 9999 } });
    const t = await threadOf(s, p.leaderThreadId);
    expect(t).toMatchObject({ unread: 0, lastReadSeq: last.seq });
    await browser(s, `/api/threads/${p.leaderThreadId}/read`, { body: { seq: 0 } });
    expect((await threadOf(s, p.leaderThreadId)).lastReadSeq).toBe(last.seq);
    // 未読は利用者ごと
    const other = await login("second@example.com");
    expect((await threadOf(other, p.leaderThreadId)).unread).toBe(2);
  });
});

describe("W33 claim（スレッド）", () => {
  it("受信箱に起こすものがあるスレッドを渡し、受信箱・文脈（直近の発言・開いている指示・話し中）を付ける。ターンの終わりで消化・ack", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r, undefined, "台本");
    const inst = await runnerCreateInstruction(r, p.project.id, { title: "台本 10 本" });
    const ceo = ((await (await postCeo(s, "thread-coo", "たすかる！", { contextProjectId: p.project.id })).json()) as { message: ThreadMessage }).message;
    // wakes=0 の報告も次のターンの頭に入る
    await runner(r, "/api/runner/threads/thread-coo/inbox", { body: { kind: "leader_report", wakes: false, instructionId: inst.id, payload: { leaderName: "台本", summary: "ニッチに", change: "direction" } } });
    await postCeo(s, p.leaderThreadId, "ニッチにして");
    const out = await claimThread(r);
    expect(out.thread.id).toBe("thread-coo");
    expect(out.inbox.map((x) => x.kind)).toEqual(["ceo_message", "leader_report"]);
    expect(out.inbox[0]!.payload).toMatchObject({ body: "たすかる！", contextProjectName: "台本" });
    expect(out.context.viewing).toBe("プロジェクト「台本」");
    expect(out.context.recentMessages.at(-1)?.id).toBe(ceo.id);
    expect(out.context.openInstructions).toEqual([expect.objectContaining({ id: inst.id, title: "台本 10 本", revision: 1, talkingWithCeo: true })]);
    expect(out.context.talkingProjectIds).toEqual([p.project.id]);
    expect(out.context.projects.map((x) => x.id)).toContain(p.project.id);
    // 次の claim はリーダーのスレッド（COO は握られている）
    const next = await claimThread(r);
    expect(next.thread.id).toBe(p.leaderThreadId);
    expect((await claim(r, ["thread"])).status).toBe(204);
    const sid = crypto.randomUUID();
    await createSession(r, { id: sid, threadId: "thread-coo", role: "coo" });
    const done = await runner(r, "/api/runner/threads/thread-coo/turn-done", {
      body: { consumedInboxIds: out.inbox.map((x) => x.id), awaitingReply: false, ackMessageIds: [ceo.id], sessionId: sid, numTurns: 2 },
    });
    expect(done.status).toBe(204);
    expect((await env.DB.prepare("SELECT reaction FROM thread_messages WHERE id = ?").bind(ceo.id).first())?.reaction).toBe("ack");
    expect((await env.DB.prepare("SELECT status, lease_runner_id FROM threads WHERE id = 'thread-coo'").first())).toEqual({ status: "idle", lease_runner_id: null });
    expect((await env.DB.prepare("SELECT turns FROM agent_sessions WHERE id = ?").bind(sid).first())?.turns).toBe(2);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE thread_id = 'thread-coo' AND status = 'pending'").first())?.n).toBe(0);
  });

  it("ターン中の発言は残り、終わると queued に戻る。lease 切れの running は取り直せる", async () => {
    const s = await login();
    const r = await registerRunner();
    const r2 = await registerRunner();
    await clearWork();
    await postCeo(s, "thread-coo", "一つ目");
    const out = await claimThread(r);
    await postCeo(s, "thread-coo", "二つ目（ターン中）");
    await runner(r, "/api/runner/threads/thread-coo/turn-done", { body: { consumedInboxIds: out.inbox.map((x) => x.id), awaitingReply: true, ackMessageIds: [], sessionId: crypto.randomUUID() } });
    expect((await env.DB.prepare("SELECT status, awaiting_reply FROM threads WHERE id = 'thread-coo'").first())).toEqual({ status: "queued", awaiting_reply: 1 });
    await claimThread(r);
    await env.DB.prepare("UPDATE threads SET lease_expires_at = ? WHERE id = 'thread-coo'").bind(Date.now() - 1).run();
    const again = await claimThread(r2);
    expect(again.inbox.map((x) => x.payload.body)).toEqual(["二つ目（ターン中）"]);
  });

  it("会話の区切り: リーダーのスレッドを離れたら、未報告の CEO の発言があるときだけ区切りを入れる", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r);
    expect((await browser(s, `/api/threads/${p.leaderThreadId}/leave`, { method: "POST" })).status).toBe(204);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE thread_id = ?").bind(p.leaderThreadId).first())?.n).toBe(0);
    const ceo = ((await (await postCeo(s, p.leaderThreadId, "方向を変えたい")).json()) as { message: ThreadMessage }).message;
    // ターンが済むまでは区切りを入れない
    await browser(s, `/api/threads/${p.leaderThreadId}/leave`, { method: "POST" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE thread_id = ? AND kind = 'instruction_event'").bind(p.leaderThreadId).first())?.n).toBe(0);
    const out = await claimThread(r);
    await runner(r, `/api/runner/threads/${p.leaderThreadId}/turn-done`, { body: { consumedInboxIds: out.inbox.map((x) => x.id), awaitingReply: false, ackMessageIds: [], sessionId: crypto.randomUUID() } });
    await browser(s, `/api/threads/${p.leaderThreadId}/leave`, { method: "POST" });
    const brk = await env.DB.prepare("SELECT wakes, json_extract(payload, '$.type') AS type FROM thread_inbox WHERE thread_id = ? AND kind = 'instruction_event'").bind(p.leaderThreadId).first();
    expect(brk).toEqual({ wakes: 1, type: "conversation_break" });
    // 2 回目は入れない（区切りより後の発言が無い）
    await browser(s, `/api/threads/${p.leaderThreadId}/leave`, { method: "POST" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE thread_id = ? AND kind = 'instruction_event'").bind(p.leaderThreadId).first())?.n).toBe(1);
    // 相づち（ack）と、リーダーが報告した（leader_report の）あとの発言は数えない
    const out2 = await claimThread(r);
    await runner(r, `/api/runner/threads/${p.leaderThreadId}/turn-done`, { body: { consumedInboxIds: out2.inbox.map((x) => x.id), awaitingReply: false, ackMessageIds: [], sessionId: crypto.randomUUID() } });
    const ack = ((await (await postCeo(s, p.leaderThreadId, "たすかる！")).json()) as { message: ThreadMessage }).message;
    const out3 = await claimThread(r);
    await runner(r, `/api/runner/threads/${p.leaderThreadId}/turn-done`, { body: { consumedInboxIds: out3.inbox.map((x) => x.id), awaitingReply: false, ackMessageIds: [ack.id], sessionId: crypto.randomUUID() } });
    await browser(s, `/api/threads/${p.leaderThreadId}/leave`, { method: "POST" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE thread_id = ? AND kind = 'instruction_event'").bind(p.leaderThreadId).first())?.n).toBe(1);
    await postCeo(s, p.leaderThreadId, "もう一つ方針を");
    const out4 = await claimThread(r);
    await agentMessage(r, "thread-coo", { authorKind: "leader", authorAgentId: p.leaderId, kind: "leader_report", body: "方針を変えた", ref: { threadId: p.leaderThreadId } });
    await runner(r, `/api/runner/threads/${p.leaderThreadId}/turn-done`, { body: { consumedInboxIds: out4.inbox.map((x) => x.id), awaitingReply: false, ackMessageIds: [], sessionId: crypto.randomUUID() } });
    await browser(s, `/api/threads/${p.leaderThreadId}/leave`, { method: "POST" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM thread_inbox WHERE thread_id = ? AND kind = 'instruction_event'").bind(p.leaderThreadId).first())?.n).toBe(1);
    void ceo;
  });

  it("15 分（テストでは環境変数）たった会話の区切りは claim のついでに入る", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r);
    await postCeo(s, p.leaderThreadId, "ちょっと相談");
    const out = await claimThread(r);
    await runner(r, `/api/runner/threads/${p.leaderThreadId}/turn-done`, { body: { consumedInboxIds: out.inbox.map((x) => x.id), awaitingReply: false, ackMessageIds: [], sessionId: crypto.randomUUID() } });
    expect((await claim(r, ["thread"])).status).toBe(204);
    await env.DB.prepare("UPDATE thread_messages SET created_at = created_at - 3600000 WHERE thread_id = ? AND author_kind = 'ceo'").bind(p.leaderThreadId).run();
    const brk = await claimThread(r);
    expect(brk.thread.id).toBe(p.leaderThreadId);
    expect(brk.inbox.map((x) => x.payload.type)).toEqual(["conversation_break"]);
  });
});

describe("W34 版", () => {
  it("expectedRevision が古ければ 409 stale_revision、revisionBump で +1", async () => {
    await login();
    const r = await registerRunner();
    const p = await createProject(r);
    const inst = await runnerCreateInstruction(r, p.project.id);
    await runner(r, `/api/runner/instructions/${inst.id}`, { method: "PATCH", body: { status: "running", phase: "leader" } });
    const bump = await runner(r, `/api/runner/instructions/${inst.id}`, { method: "PATCH", body: { revisionBump: true } });
    expect(((await bump.json()) as InstructionSummary).revision).toBe(2);
    await runner(r, `/api/runner/instructions/${inst.id}`, { method: "PATCH", body: { phase: "coo" } });
    const stale = await runner(r, `/api/runner/instructions/${inst.id}`, { method: "PATCH", body: { status: "review", resultSummary: "古い報告", expectedRevision: 1 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_revision", details: { revision: 2 } } });
    expect(await statusOf(inst.id)).toBe("running");
    const ok = await runner(r, `/api/runner/instructions/${inst.id}`, { method: "PATCH", body: { status: "review", resultSummary: "10 本の案", expectedRevision: 2 } });
    expect(((await ok.json()) as InstructionSummary)).toMatchObject({ status: "review", resultSummary: "10 本の案" });
  });
});

describe("W35 差し戻し", () => {
  it("コメントは CEO の発言として COO スレッドへ（指示のカード付き）、受信箱は sendBack、指示は queued・phase=coo", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r);
    const id = await insertInstruction(s.userId, { status: "review", projectId: p.project.id, phase: "coo" });
    const res = await browser(s, `/api/instructions/${id}/transition`, { body: { action: "send_back", expectedStatus: "review", comment: "もっとニッチに" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { instruction: InstructionSummary }).instruction).toMatchObject({ status: "queued", phase: "coo" });
    const msg = await env.DB.prepare("SELECT author_kind, body, instruction_id FROM thread_messages WHERE thread_id = 'thread-coo' AND instruction_id = ? AND author_kind = 'ceo'").bind(id).first();
    expect(msg).toEqual({ author_kind: "ceo", body: "もっとニッチに", instruction_id: id });
    const inbox = await env.DB.prepare("SELECT wakes, json_extract(payload, '$.sendBack') AS sb FROM thread_inbox WHERE thread_id = 'thread-coo' AND instruction_id = ? AND kind = 'ceo_message'").bind(id).first();
    expect(inbox).toEqual({ wakes: 1, sb: 1 });
    expect((await env.DB.prepare("SELECT feedback FROM instructions WHERE id = ?").bind(id).first())?.feedback).toBe("もっとニッチに");
  });

  it("承認・取消・再実行は会話に知らせ（notice）と受信箱（承認・取消はターンを起こさない、再実行は起こす）", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r);
    const a = await insertInstruction(s.userId, { status: "review", projectId: p.project.id });
    await browser(s, `/api/instructions/${a}/transition`, { body: { action: "approve", expectedStatus: "review" } });
    const b = await insertInstruction(s.userId, { status: "running", projectId: p.project.id });
    await browser(s, `/api/instructions/${b}/transition`, { body: { action: "cancel", expectedStatus: "running" } });
    const c = await insertInstruction(s.userId, { status: "failed", projectId: p.project.id });
    await browser(s, `/api/instructions/${c}/transition`, { body: { action: "retry", expectedStatus: "failed" } });
    const notices = (await env.DB.prepare("SELECT thread_id, body, instruction_id FROM thread_messages WHERE kind = 'notice' AND instruction_id IN (?, ?, ?) ORDER BY rowid").bind(a, b, c).all()).results;
    expect(notices).toEqual([
      { thread_id: "thread-coo", body: "承認", instruction_id: a },
      { thread_id: "thread-coo", body: "取消", instruction_id: b },
      { thread_id: p.leaderThreadId, body: "取消", instruction_id: b },
      { thread_id: "thread-coo", body: "再実行", instruction_id: c },
    ]);
    const wakes = (await env.DB.prepare("SELECT thread_id, instruction_id, wakes FROM thread_inbox WHERE kind = 'instruction_event' AND instruction_id IN (?, ?, ?) ORDER BY created_at, rowid").bind(a, b, c).all()).results;
    expect(wakes).toEqual([
      { thread_id: "thread-coo", instruction_id: a, wakes: 0 },
      { thread_id: p.leaderThreadId, instruction_id: a, wakes: 0 },
      { thread_id: "thread-coo", instruction_id: b, wakes: 0 },
      { thread_id: p.leaderThreadId, instruction_id: b, wakes: 0 },
      { thread_id: "thread-coo", instruction_id: c, wakes: 1 },
    ]);
    expect((await env.DB.prepare("SELECT phase FROM instructions WHERE id = ?").bind(c).first())?.phase).toBe("coo");
  });
});
