// W18 セッション、W19 トランスクリプト、W20 追加の依頼、W21 承認、W22 中断（DESIGN-v2 5.3・5.6・5.7・7.6・8.3・8.4）
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LIMITS, type AgentSessionSummary, type Decision, type InstructionDetail, type SessionInput, type TranscriptItem } from "@baton/shared";
import {
  browser,
  claim,
  clearWork,
  createSession,
  login,
  membersInstruction,
  registerRunner,
  runner,
  statusOf,
} from "./helpers.ts";

const item = (sessionId: string, seq: number, fields: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), sessionId, threadId: null, instructionId: null, seq, kind: "text", author: "claude",
  toolName: null, toolUseId: null, parentToolUseId: null, summary: `項目 ${seq}`, body: { text: `本文 ${seq}` }, truncated: false, isError: false, createdAt: Date.now(),
  ...fields,
});

describe("W18 セッション", () => {
  it("作成は冪等。スレッドのセッションは current_session_id になる。PATCH で状態・動き・ターン・推定額", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await createSession(r, { threadId: "thread-coo", role: "coo", title: "COO" });
    expect(await createSession(r, { id, threadId: "thread-coo", role: "coo" })).toBe(id);
    expect((await env.DB.prepare("SELECT current_session_id FROM threads WHERE id = 'thread-coo'").first())?.current_session_id).toBe(id);
    const res = await runner(r, `/api/runner/sessions/${id}`, {
      method: "PATCH",
      body: { status: "running", activity: "読んでいる org.md", turnsDelta: 3, costUsdDelta: 0.25, tokensInDelta: 100, started: true, claudeVersion: "2.1.303" },
    });
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: AgentSessionSummary };
    expect(session).toMatchObject({ status: "running", activity: "読んでいる org.md", turns: 3, costUsdEst: 0.25 });
    expect(session.startedAt).not.toBeNull();
    // スレッドの一覧に動きが出る
    const threads = (await (await browser(s, "/api/threads")).json()) as { items: { id: string; activity: string | null }[] };
    expect(threads.items[0]!.id).toBe("thread-coo");
    // threadId・instructionId のどちらも無ければ 400、無い指示は 404
    expect((await runner(r, "/api/runner/sessions", { body: { id: crypto.randomUUID(), threadId: null, instructionId: null, agentId: null, role: "member", projectId: null, taskId: null, workspaceId: null, title: "x", cwd: "", model: null } })).status).toBe(400);
    expect((await runner(r, `/api/runner/sessions/${crypto.randomUUID()}`, { method: "PATCH", body: { activity: "x" } })).status).toBe(404);
  });

  it("メンバーのセッションの推定額は指示の合計にも入り、詳細の sessions に出る", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const id = await createSession(r, { instructionId: a.id, projectId: a.projectId, taskId: a.taskId, title: "リサーチ" });
    await runner(r, `/api/runner/sessions/${id}`, { method: "PATCH", body: { status: "running", costUsdDelta: 1.5, activity: "編集している research/a.md" } });
    const detail = (await (await browser(s, `/api/instructions/${a.id}`)).json()) as InstructionDetail;
    expect(detail.instruction.costUsdEst).toBe(1.5);
    expect(detail.instruction.activeSessionCount).toBe(1);
    expect(detail.instruction.activity).toBe("編集している research/a.md");
    expect(detail.sessions.map((x) => x.id)).toContain(id);
  });
});

describe("W19 トランスクリプト", () => {
  it("取得は最新 limit 件を古い順、before・after で前後、instructionId で絞る。全文は /api/transcript-items/:id", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await createSession(r, { threadId: "thread-coo", role: "coo" });
    const iid = crypto.randomUUID();
    const items = Array.from({ length: 6 }, (_, n) => item(id, n, n % 2 === 0 ? { threadId: "thread-coo" } : {}));
    expect((await runner(r, "/api/runner/transcript", { body: { items } })).status).toBe(200);
    const page = (await (await browser(s, `/api/sessions/${id}/transcript?limit=3`)).json()) as { items: TranscriptItem[]; hasMoreBefore: boolean };
    expect(page.items.map((i) => i.seq)).toEqual([3, 4, 5]);
    expect(page.hasMoreBefore).toBe(true);
    const before = (await (await browser(s, `/api/sessions/${id}/transcript?before=3&limit=10`)).json()) as { items: TranscriptItem[]; hasMoreBefore: boolean };
    expect(before.items.map((i) => i.seq)).toEqual([0, 1, 2]);
    expect(before.hasMoreBefore).toBe(false);
    const after = (await (await browser(s, `/api/sessions/${id}/transcript?after=4`)).json()) as { items: TranscriptItem[]; hasMoreBefore: boolean };
    expect(after.items.map((i) => i.seq)).toEqual([5]);
    expect(after.hasMoreBefore).toBe(true);
    const full = (await (await browser(s, `/api/transcript-items/${items[2]!.id}`)).json()) as TranscriptItem;
    expect(full).toMatchObject({ seq: 2, body: { text: "本文 2" } });
    expect((await browser(s, `/api/sessions/${id}/transcript?instructionId=${iid}`)).status).toBe(200);
    expect((await browser(s, `/api/sessions/${crypto.randomUUID()}/transcript`)).status).toBe(404);
  });

  it("1 回 50 件・512KB まで。無いセッションは 400", async () => {
    await login();
    const r = await registerRunner();
    const id = await createSession(r, { threadId: "thread-coo", role: "coo" });
    const many = Array.from({ length: LIMITS.transcriptPerPost + 1 }, (_, n) => item(id, n));
    expect((await runner(r, "/api/runner/transcript", { body: { items: many } })).status).toBe(400);
    const big = [item(id, 0, { body: { text: "x".repeat(LIMITS.transcriptPostBytes) } })];
    expect((await runner(r, "/api/runner/transcript", { body: { items: big } })).status).toBe(400);
    expect((await runner(r, "/api/runner/transcript", { body: { items: [item(crypto.randomUUID(), 0)] } })).status).toBe(400);
  });

  it("1 セッションの上限を超えたら tool_result・thinking の body を空に、1 指示の上限を超えたら text・output・result・approval だけ", async () => {
    await login();
    const r = await registerRunner();
    const id = await createSession(r, { threadId: "thread-coo", role: "coo" });
    const iid = (await membersInstruction(r)).id;
    // 件数を上限まで埋めたことにする（行を直接入れる）
    const stmts = [];
    for (let n = 0; n < LIMITS.itemsPerSession; n += 500) {
      const values = Array.from({ length: Math.min(500, LIMITS.itemsPerSession - n) }, (_, k) => `('${crypto.randomUUID()}', '${id}', NULL, '${iid}', ${n + k}, 'text', 'claude', '', '{}', 0)`).join(",");
      stmts.push(env.DB.prepare(`INSERT INTO transcript_items (id, session_id, thread_id, instruction_id, seq, kind, author, summary, body, created_at) VALUES ${values}`));
    }
    await env.DB.batch(stmts);
    const base = LIMITS.itemsPerSession;
    await runner(r, "/api/runner/transcript", { body: { items: [item(id, base, { kind: "tool_result", body: { text: "長い結果" } }), item(id, base + 1, { kind: "text" })] } });
    const rows = await env.DB.prepare("SELECT seq, body, truncated FROM transcript_items WHERE session_id = ? AND seq >= ? ORDER BY seq").bind(id, base).all();
    expect(rows.results).toEqual([
      { seq: base, body: "{}", truncated: 1 },
      { seq: base + 1, body: JSON.stringify({ text: `本文 ${base + 1}` }), truncated: 0 },
    ]);
    // 1 指示の上限
    await env.DB.prepare("UPDATE transcript_items SET instruction_id = ? WHERE session_id = ?").bind(iid, id).run();
    const filler = [];
    for (let n = 0; n < LIMITS.itemsPerInstruction - LIMITS.itemsPerSession - 2; n += 500) {
      const sid = await createSession(r, { threadId: "thread-coo", role: "coo" });
      const values = Array.from({ length: Math.min(500, LIMITS.itemsPerInstruction - LIMITS.itemsPerSession - 2 - n) }, (_, k) => `('${crypto.randomUUID()}', '${sid}', NULL, '${iid}', ${k}, 'text', 'claude', '', '{}', 0)`).join(",");
      filler.push(env.DB.prepare(`INSERT INTO transcript_items (id, session_id, thread_id, instruction_id, seq, kind, author, summary, body, created_at) VALUES ${values}`));
    }
    await env.DB.batch(filler);
    const out = await runner(r, "/api/runner/transcript", {
      body: { items: [item(id, base + 2, { instructionId: iid, kind: "tool_use" }), item(id, base + 3, { instructionId: iid, kind: "result" })] },
    });
    expect(((await out.json()) as { accepted: number }).accepted).toBe(1);
    expect((await env.DB.prepare("SELECT kind FROM transcript_items WHERE session_id = ? AND seq = ?").bind(id, base + 3).first())?.kind).toBe("result");
  });
});

describe("W20 追加の依頼", () => {
  it("メンバーのセッションに送ると pending、ランナーが受け取り届けたら delivered。clientId で冪等。COO のセッションには送れない", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id, taskId: a.taskId });
    await runner(r, `/api/runner/sessions/${sid}`, { method: "PATCH", body: { status: "idle" } });
    // lease を外す（止まっているメンバーへの追加の依頼で、また claim できる）
    await runner(r, `/api/runner/instructions/${a.id}/release`, { body: { reason: "shutdown", notBefore: null } });
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE instruction_id = ?").bind(a.id).run();
    await runner(r, `/api/runner/sessions/${sid}`, { method: "PATCH", body: { status: "done" } });
    expect((await claim(r, ["instruction"])).status).toBe(204);
    const clientId = crypto.randomUUID();
    const res = await browser(s, `/api/sessions/${sid}/messages`, { body: { clientId, body: "表も足して" } });
    expect(res.status).toBe(202);
    const { input } = (await res.json()) as { input: SessionInput };
    expect(input).toMatchObject({ status: "pending", body: "表も足して", instructionId: a.id });
    expect((await browser(s, `/api/sessions/${sid}/messages`, { body: { clientId, body: "表も足して" } })).status).toBe(200);
    const c = await claim(r, ["instruction"]);
    expect(c.status).toBe(200);
    const pending = (await (await runner(r, `/api/runner/sessions/${sid}/inputs`)).json()) as { items: SessionInput[] };
    expect(pending.items.map((i) => i.id)).toEqual([input.id]);
    const delivered = (await (await runner(r, `/api/runner/inputs/${input.id}/delivered`, { method: "POST" })).json()) as SessionInput;
    expect(delivered.status).toBe("delivered");
    expect(((await (await runner(r, `/api/runner/sessions/${sid}/inputs`)).json()) as { items: unknown[] }).items).toEqual([]);
    // 終わった指示（claim で拾えない状態）のメンバーには送れない
    await env.DB.prepare("UPDATE instructions SET status = 'done' WHERE id = ?").bind(a.id).run();
    expect((await browser(s, `/api/sessions/${sid}/messages`, { body: { clientId: crypto.randomUUID(), body: "x" } })).status).toBe(409);
    const coo = await createSession(r, { threadId: "thread-coo", role: "coo" });
    expect((await browser(s, `/api/sessions/${coo}/messages`, { body: { clientId: crypto.randomUUID(), body: "x" } })).status).toBe(400);
  });
});

describe("W21 承認", () => {
  it("承認の依頼で awaiting_approval・リーダーのスレッドに入口・指示は running のまま。許可で decision.answered、拒否は理由付き。verdict 無しは 400", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id, taskId: a.taskId });
    const req = (id: string) => ({ id, instructionId: a.id, sessionId: sid, taskId: a.taskId, askedByAgentId: null, toolName: "Bash", toolInput: { command: "npm install zod" }, toolUseId: "tu", question: "npm install zod" });
    const id1 = crypto.randomUUID();
    const res = await runner(r, "/api/runner/approvals", { body: req(id1) });
    expect(res.status).toBe(201);
    expect(((await runner(r, "/api/runner/approvals", { body: req(id1) })).status)).toBe(200);
    const d = (await res.json()) as Decision;
    expect(d).toMatchObject({ kind: "approval", toolName: "Bash", toolInput: { command: "npm install zod" }, status: "open", sessionId: sid });
    expect(await statusOf(a.id)).toBe("running");
    expect((await env.DB.prepare("SELECT status FROM agent_sessions WHERE id = ?").bind(sid).first())?.status).toBe("awaiting_approval");
    const msg = await env.DB.prepare("SELECT kind, author_kind, notify, json_extract(ref, '$.decisionId') AS d FROM thread_messages WHERE thread_id = ? AND kind = 'approval'").bind(`thread-${a.projectId}`).first();
    expect(msg).toEqual({ kind: "approval", author_kind: "system", notify: 0, d: id1 });
    const detail = (await (await browser(s, `/api/instructions/${a.id}`)).json()) as InstructionDetail;
    expect(detail.instruction.openDecisionCount).toBe(1);
    expect(detail.openDecisions.map((x) => x.id)).toEqual([id1]);
    expect((await browser(s, `/api/decisions/${id1}/answer`, { body: { answer: "どうぞ" } })).status).toBe(400);
    const allow = (await (await browser(s, `/api/decisions/${id1}/answer`, { body: { verdict: "allow" } })).json()) as { decision: Decision };
    expect(allow.decision).toMatchObject({ status: "answered", verdict: "allow" });
    const id2 = crypto.randomUUID();
    await runner(r, "/api/runner/approvals", { body: req(id2) });
    const deny = (await (await browser(s, `/api/decisions/${id2}/answer`, { body: { verdict: "deny", answer: "外部に送らないで" } })).json()) as { decision: Decision };
    expect(deny.decision).toMatchObject({ verdict: "deny", answer: "外部に送らないで" });
  });

  it("1 指示 10 回まで（11 回目は 409）。時間切れは interrupted の判断に引き継ぎ（承認は閉じる）", async () => {
    await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id });
    const ids: string[] = [];
    for (let n = 0; n < LIMITS.approvalsPerInstruction; n++) {
      const id = crypto.randomUUID();
      ids.push(id);
      expect((await runner(r, "/api/runner/approvals", { body: { id, instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: {}, toolUseId: null, question: `q${n}` } })).status).toBe(201);
    }
    expect((await runner(r, "/api/runner/approvals", { body: { id: crypto.randomUUID(), instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: {}, toolUseId: null, question: "q" } })).status).toBe(409);
    const res = await runner(r, "/api/runner/decisions", { body: { instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: null, kind: "interrupted", question: "承認の時間切れ", fromApprovalId: ids[0] } });
    expect(res.status).toBe(201);
    const d = (await res.json()) as Decision;
    expect(d).toMatchObject({ kind: "interrupted", toolName: "Bash" });
    expect((await env.DB.prepare("SELECT status FROM decisions WHERE id = ?").bind(ids[0]).first())?.status).toBe("canceled");
    expect(await statusOf(a.id)).toBe("needs_decision");
  });
});

describe("W22 中断", () => {
  it("スレッド・セッションの中断はランナーに合図し、ハートビートの応答でも 1 回だけ返す", async () => {
    const s = await login();
    const r = await registerRunner();
    const sid = await createSession(r, { threadId: "thread-coo", role: "coo" });
    expect((await browser(s, "/api/threads/thread-coo/interrupt", { method: "POST" })).status).toBe(202);
    expect((await browser(s, `/api/sessions/${sid}/interrupt`, { method: "POST" })).status).toBe(202);
    expect((await browser(s, `/api/sessions/${crypto.randomUUID()}/interrupt`, { method: "POST" })).status).toBe(404);
    const hb = {
      version: "2.0.0", tailnetUrl: null, activeInstructionIds: [], activeSessionIds: [sid], activeThreadIds: [],
      quota: { observedAt: null, fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null }, status: "unknown", rejectedType: null, blockedUntil: null, paused: false },
      claudeVersion: "2.1.303", claudeAuth: "ok", profiles: [],
    };
    const out = (await (await runner(r, "/api/runner/heartbeat", { body: hb })).json()) as { interruptThreadIds: string[]; interruptSessionIds: string[] };
    expect(out.interruptThreadIds).toEqual(["thread-coo"]);
    expect(out.interruptSessionIds).toEqual([sid]);
    const again = (await (await runner(r, "/api/runner/heartbeat", { body: hb })).json()) as { interruptThreadIds: string[]; interruptSessionIds: string[] };
    expect(again.interruptThreadIds).toEqual([]);
    expect(again.interruptSessionIds).toEqual([]);
  });

  it("取消した指示はハートビートの cancelInstructionIds に入る", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id });
    await browser(s, `/api/instructions/${a.id}/transition`, { body: { action: "cancel", expectedStatus: "running" } });
    const hb = {
      version: "2.0.0", tailnetUrl: null, activeInstructionIds: [a.id], activeSessionIds: [], activeThreadIds: [],
      quota: { observedAt: null, fiveHour: { utilization: null, resetsAt: null }, sevenDay: { utilization: null, resetsAt: null }, status: "unknown", rejectedType: null, blockedUntil: null, paused: false },
      claudeVersion: null, claudeAuth: "ok", profiles: [],
    };
    const out = (await (await runner(r, "/api/runner/heartbeat", { body: hb })).json()) as { cancelInstructionIds: string[] };
    expect(out.cancelInstructionIds).toEqual([a.id]);
    // 取消のあとでもセッションの終わりは書ける。動きの更新は書けない
    expect((await runner(r, `/api/runner/sessions/${sid}`, { method: "PATCH", body: { status: "canceled", ended: true } })).status).toBe(200);
    expect((await runner(r, `/api/runner/sessions/${sid}`, { method: "PATCH", body: { activity: "x" } })).status).toBe(409);
  });
});
