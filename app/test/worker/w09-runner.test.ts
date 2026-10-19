// W9〜W13: ランナー認証・claim（指示）・lease を持たない書き込み・判断・トランスクリプトの重複 seq（v1 の W9〜W13 を v2 の形に）
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ClaimOutput, type ClaimOutput as ClaimOutputT, type Decision, type InstructionSummary } from "@baton/shared";
import { sha256Hex } from "../../src/worker/lib/crypto.ts";
import {
  browser,
  call,
  claim,
  clearWork,
  createProject,
  createSession,
  insertInstruction,
  login,
  membersInstruction,
  registerRunner,
  runner,
  runnerCreateInstruction,
  statusOf,
  type TestRunner,
  type TestSession,
} from "./helpers.ts";

async function claimOut(r: TestRunner, kinds = ["instruction"], extra: Record<string, unknown> = {}): Promise<ClaimOutputT | null> {
  const res = await claim(r, kinds, extra);
  if (res.status === 204) return null;
  if (res.status !== 200) throw new Error(`claim ${res.status} ${await res.text()}`);
  return ClaimOutput.parse(await res.json());
}

describe("W9 ランナー認証", () => {
  it("トークン無し・誤り・revoked で 401", async () => {
    const r = await registerRunner();
    const body = { kinds: ["thread"], activeThreadIds: [], activeInstructionIds: [], quotaPaused: false };
    expect((await call("/api/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await runner("wrong-token", "/api/runner/claim", { body })).status).toBe(401);
    await env.DB.prepare("UPDATE runners SET revoked = 1 WHERE token_hash = ?").bind(await sha256Hex(r.token)).run();
    const revoked = await runner(r, "/api/runner/claim", { body });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("ランナー用 API に Cookie だけでは入れない。bot トークンでも入れない", async () => {
    const s = await login();
    expect((await browser(s, "/api/runner/claim", { body: {} })).status).toBe(401);
    expect((await runner("btn_bot_x", "/api/runner/heartbeat", { body: {} })).status).toBe(401);
  });
});

describe("W10 claim（指示・確定）", () => {
  let s: TestSession;
  let r: TestRunner;
  beforeEach(async () => {
    s = await login();
    r = await registerRunner();
    await clearWork();
  });

  it("members の段階で pending のタスクがある指示を古い順に、lease を付けて渡す", async () => {
    const a = await membersInstruction(r);
    await env.DB.prepare("UPDATE instructions SET created_at = created_at - 5000 WHERE id = ?").bind(a.id).run();
    const b = await membersInstruction(r);
    const first = await claimOut(r);
    expect(first?.kind).toBe("instruction");
    if (first?.kind !== "instruction") throw new Error("kind");
    expect(first.instruction.id).toBe(a.id);
    expect(first.instruction.attempt).toBe(1);
    expect(first.tasks.map((t) => t.id)).toEqual([a.taskId]);
    expect(first.tasks[0]!.paths).toEqual(["research/"]);
    expect(first.project.id).toBe(a.projectId);
    const row = await env.DB.prepare("SELECT lease_runner_id, lease_expires_at, status FROM instructions WHERE id = ?").bind(a.id).first<{ lease_runner_id: string; lease_expires_at: number; status: string }>();
    expect(row).toMatchObject({ lease_runner_id: r.runnerId, status: "running" });
    expect(row!.lease_expires_at).toBeGreaterThan(Date.now() + 9 * 60_000);
    const second = await claimOut(r, ["instruction"], { activeInstructionIds: [a.id] });
    expect(second?.kind === "instruction" && second.instruction.id).toBe(b.id);
    expect(await claimOut(r, ["instruction"], { activeInstructionIds: [a.id, b.id] })).toBeNull();
  });

  it("leader・coo の段階、not_before が未来、枠でメンバーを止めている間（新しいタスクだけ）は渡さない", async () => {
    const p = await createProject(r);
    await runnerCreateInstruction(r, p.project.id); // queued・leader
    const later = await membersInstruction(r, p.project.id);
    await env.DB.prepare("UPDATE instructions SET not_before = ? WHERE id = ?").bind(Date.now() + 60_000, later.id).run();
    expect(await claimOut(r)).toBeNull();
    await env.DB.prepare("UPDATE instructions SET not_before = NULL WHERE id = ?").bind(later.id).run();
    expect(await claimOut(r, ["instruction"], { quotaPaused: true })).toBeNull();
    expect((await claimOut(r, ["instruction"], { quotaPaused: false }))?.kind).toBe("instruction");
  });

  it("lease 切れを取り直す（attempt は 2）。同時の claim は 1 つにだけ渡る", async () => {
    const other = await registerRunner();
    const a = await membersInstruction(r);
    expect((await claimOut(other))?.kind).toBe("instruction");
    await env.DB.prepare("UPDATE instructions SET lease_expires_at = ? WHERE id = ?").bind(Date.now() - 1, a.id).run();
    const results = await Promise.all([claimOut(r), claimOut(r), claimOut(other)]);
    const got = results.filter((x) => x !== null);
    expect(got).toHaveLength(1);
    expect(got[0]!.kind === "instruction" && got[0]!.instruction.attempt).toBe(2);
  });

  it("承認から 20 秒たった done を finalize として渡す（期限前・確定済みは渡さない）", async () => {
    const p = await createProject(r);
    const early = await insertInstruction(s.userId, { status: "done", projectId: p.project.id, statusChangedAt: Date.now() - 5_000 });
    expect(await claimOut(r, ["finalize"])).toBeNull();
    await env.DB.prepare("UPDATE instructions SET status_changed_at = ? WHERE id = ?").bind(Date.now() - 21_000, early).run();
    const got = await claimOut(r, ["finalize"]);
    expect(got?.kind).toBe("finalize");
    expect(got?.kind === "finalize" && got.instruction.id).toBe(early);
    expect(await claimOut(r, ["finalize"], { activeInstructionIds: [early] })).toBeNull();
  });
});

describe("W11 lease を持たないランナーの書き込みは 409", () => {
  it("指示・タスク・セッション・作業場所・承認・判断・成果物", async () => {
    await login();
    const holder = await registerRunner();
    const intruder = await registerRunner();
    await clearWork();
    const a = await membersInstruction(holder);
    expect((await claimOut(holder))?.kind).toBe("instruction");
    const sessionId = await createSession(holder, { instructionId: a.id, projectId: a.projectId, taskId: a.taskId });
    const reqs: [string, string, unknown][] = [
      ["PATCH", `/api/runner/instructions/${a.id}`, { title: "x" }],
      ["POST", `/api/runner/instructions/${a.id}/release`, { reason: "shutdown", notBefore: null }],
      ["POST", "/api/runner/tasks", { tasks: [{ instructionId: a.id, parentTaskId: null, assigneeAgentId: null, kind: "work", planKey: "t9", dependsOn: [], title: "x", spec: "", paths: [], round: 1, seq: 9 }] }],
      ["PATCH", `/api/runner/tasks/${a.taskId}`, { status: "running" }],
      ["POST", "/api/runner/sessions", { id: crypto.randomUUID(), threadId: null, instructionId: a.id, agentId: null, role: "member", projectId: null, taskId: null, workspaceId: null, title: "x", cwd: "/x", model: null }],
      ["PATCH", `/api/runner/sessions/${sessionId}`, { activity: "x" }],
      ["POST", "/api/runner/workspaces", { id: crypto.randomUUID(), instructionId: a.id, projectId: a.projectId, purpose: "integration", taskId: null, parentId: null, kind: "baton", repoPath: "/r", worktreePath: "/w", branch: "b", baseRef: "main", baseSha: "a".repeat(40) }],
      ["POST", "/api/runner/approvals", { id: crypto.randomUUID(), instructionId: a.id, sessionId, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: {}, toolUseId: null, question: "q" }],
      ["POST", "/api/runner/decisions", { instructionId: a.id, sessionId, taskId: null, askedByAgentId: null, kind: "interrupted", question: "q" }],
      ["POST", "/api/runner/artifacts", { instructionId: a.id, taskId: null, relPath: "a.md", title: "a", mime: "text/markdown", sizeBytes: 1, sha256: "a".repeat(64), previewText: null }],
      ["POST", "/api/runner/transcript", { items: [{ id: crypto.randomUUID(), sessionId, threadId: null, instructionId: a.id, seq: 0, kind: "text", author: "claude", toolName: null, toolUseId: null, parentToolUseId: null, summary: "x", body: {}, truncated: false, isError: false, createdAt: Date.now() }] }],
    ];
    for (const [method, path, body] of reqs) {
      const res = await runner(intruder, path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(409);
    }
    // 取り消された指示にも書けない
    const own = await runner(holder, `/api/runner/instructions/${a.id}`, { method: "PATCH", body: { title: "ok" } });
    expect(own.status).toBe(200);
    await env.DB.prepare("UPDATE instructions SET status = 'canceled' WHERE id = ?").bind(a.id).run();
    expect((await runner(holder, `/api/runner/instructions/${a.id}`, { method: "PATCH", body: { title: "x" } })).status).toBe(409);
    expect((await runner(holder, "/api/runner/tasks", { body: reqs[2]![2] })).status).toBe(409);
  });

  it("スレッド: lease を持たない turn-done・release は 409、他のランナーが回しているスレッドに書けない", async () => {
    const s = await login();
    const holder = await registerRunner();
    const intruder = await registerRunner();
    await clearWork();
    await browser(s, "/api/threads/thread-coo/messages", { body: { clientId: crypto.randomUUID(), body: "やあ" } });
    const c = await claimOut(holder, ["thread"]);
    expect(c?.kind).toBe("thread");
    const done = { consumedInboxIds: [], awaitingReply: false, ackMessageIds: [], sessionId: crypto.randomUUID() };
    expect((await runner(intruder, "/api/runner/threads/thread-coo/turn-done", { body: done })).status).toBe(409);
    expect((await runner(intruder, "/api/runner/threads/thread-coo/release", { body: { reason: "shutdown", notBefore: null } })).status).toBe(409);
    const msg = { id: crypto.randomUUID(), authorKind: "coo", authorAgentId: null, kind: "chat", body: "x", instructionId: null, sessionId: null, ref: {}, status: "complete", notify: true };
    expect((await runner(intruder, "/api/runner/threads/thread-coo/messages", { body: msg })).status).toBe(409);
    expect((await runner(holder, "/api/runner/threads/thread-coo/messages", { body: msg })).status).toBe(201);
    expect((await runner(holder, "/api/runner/threads/thread-coo/turn-done", { body: done })).status).toBe(204);
    expect((await runner(holder, "/api/runner/threads/thread-coo/turn-done", { body: done })).status).toBe(409);
  });
});

describe("W12 判断", () => {
  it("中断の判断で paused・needs_decision・lease 解除、回答で running、二重回答は 409", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claimOut(r);
    const sessionId = await createSession(r, { instructionId: a.id, projectId: a.projectId, taskId: a.taskId });
    await runner(r, `/api/runner/sessions/${sessionId}`, { method: "PATCH", body: { status: "running" } });
    const res = await runner(r, "/api/runner/decisions", {
      body: { instructionId: a.id, sessionId, taskId: a.taskId, askedByAgentId: null, kind: "interrupted", question: "中断しました。続けますか？" },
    });
    expect(res.status).toBe(201);
    const d = (await res.json()) as Decision;
    expect(d).toMatchObject({ kind: "interrupted", status: "open", sessionId });
    const row = await env.DB.prepare("SELECT status, lease_runner_id FROM instructions WHERE id = ?").bind(a.id).first<{ status: string; lease_runner_id: string | null }>();
    expect(row).toEqual({ status: "needs_decision", lease_runner_id: null });
    const sess = await env.DB.prepare("SELECT status, pause_reason FROM agent_sessions WHERE id = ?").bind(sessionId).first();
    expect(sess).toEqual({ status: "paused", pause_reason: "interrupted" });

    const ans = await browser(s, `/api/decisions/${d.id}/answer`, { body: { answer: "続けて" } });
    expect(ans.status).toBe(200);
    const out = (await ans.json()) as { decision: Decision; instruction: InstructionSummary };
    expect(out.decision).toMatchObject({ status: "answered", answer: "続けて" });
    expect(out.instruction.status).toBe("running");
    const t = await env.DB.prepare("SELECT actor FROM status_transitions WHERE instruction_id = ? AND from_status = 'needs_decision' AND to_status = 'running'").bind(a.id).first();
    expect(t).toEqual({ actor: "ceo" });
    expect((await browser(s, `/api/decisions/${d.id}/answer`, { body: { answer: "もう一度" } })).status).toBe(409);
    // 回答済みの paused セッションがあるので、また claim できる（--resume）
    const again = await claimOut(r);
    expect(again?.kind === "instruction" && again.instruction.id).toBe(a.id);
  });

  it("他に動いているメンバーがいれば指示は running のまま。存在しない判断は 404", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claimOut(r);
    const s1 = await createSession(r, { instructionId: a.id });
    const s2 = await createSession(r, { instructionId: a.id });
    await runner(r, `/api/runner/sessions/${s2}`, { method: "PATCH", body: { status: "running" } });
    expect((await runner(r, "/api/runner/decisions", { body: { instructionId: a.id, sessionId: s1, taskId: null, askedByAgentId: null, kind: "question", question: "q" } })).status).toBe(201);
    expect(await statusOf(a.id)).toBe("running");
    expect((await browser(s, `/api/decisions/${crypto.randomUUID()}/answer`, { body: { answer: "x" } })).status).toBe(404);
  });
});

describe("W13 トランスクリプトの重複 seq は無視", () => {
  it("同じ seq を送り直しても 1 件のまま、lastSeq は最大", async () => {
    await login();
    const r = await registerRunner();
    const sessionId = await createSession(r, { threadId: "thread-coo", role: "coo" });
    const item = (seq: number, text: string) => ({
      id: crypto.randomUUID(), sessionId, threadId: "thread-coo", instructionId: null, seq, kind: "text", author: "claude",
      toolName: null, toolUseId: null, parentToolUseId: null, summary: text, body: { text }, truncated: false, isError: false, createdAt: Date.now(),
    });
    const first = await runner(r, "/api/runner/transcript", { body: { items: [item(0, "a"), item(1, "b")] } });
    expect(await first.json()).toEqual({ accepted: 2, lastSeqBySession: { [sessionId]: 1 } });
    const again = await runner(r, "/api/runner/transcript", { body: { items: [item(1, "b2"), item(2, "c")] } });
    expect(await again.json()).toEqual({ accepted: 1, lastSeqBySession: { [sessionId]: 2 } });
    const rows = await env.DB.prepare("SELECT seq, summary FROM transcript_items WHERE session_id = ? ORDER BY seq").bind(sessionId).all();
    expect(rows.results).toEqual([{ seq: 0, summary: "a" }, { seq: 1, summary: "b" }, { seq: 2, summary: "c" }]);
  });
});
