// W9〜W13: ランナー認証・claim・lease・判断・イベント。あわせて state・PATCH・release・プロジェクト・タスク・成果物
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactSchema,
  ClaimOutput,
  HeartbeatOutput,
  ProjectWithTeamSchema,
  RunnerInstructionState,
  type ClaimOutput as ClaimOutputT,
  type Decision,
  type InstructionSummary,
  type Task,
} from "@baton/shared";
import { sha256Hex } from "../../src/worker/lib/crypto.ts";
import { browser, clearQueue, createInstruction, insertInstruction, login, registerRunner, runner, statusOf, type TestRunner, type TestSession } from "./helpers.ts";

async function claim(r: TestRunner, activeIds: string[] = [], maxConcurrent = 2): Promise<ClaimOutputT | null> {
  const res = await runner(r, "/api/runner/claim", { body: { maxConcurrent, activeIds } });
  if (res.status === 204) return null;
  if (res.status !== 200) throw new Error(`claim ${res.status} ${await res.text()}`);
  return ClaimOutput.parse(await res.json());
}

/** 指示を作って claim するまで */
async function claimed(s: TestSession, r: TestRunner, body = "ランナーのテスト"): Promise<string> {
  await clearQueue();
  const inst = await createInstruction(s, body);
  const c = await claim(r);
  expect(c?.instruction.id).toBe(inst.id);
  return inst.id;
}

const sha = "a".repeat(64);

describe("W9 ランナー認証", () => {
  it("トークン無し・誤り・revoked で 401", async () => {
    const r = await registerRunner();
    const body = { maxConcurrent: 1, activeIds: [] };
    const none = await fetchRunnerNoAuth("/api/runner/claim", body);
    expect(none.status).toBe(401);
    expect((await runner("wrong-token", "/api/runner/claim", { body })).status).toBe(401);
    await env.DB.prepare("UPDATE runners SET revoked = 1 WHERE token_hash = ?").bind(await sha256Hex(r.token)).run();
    const revoked = await runner(r, "/api/runner/claim", { body });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("ランナー用 API に Cookie だけでは入れない", async () => {
    const s = await login();
    expect((await browser(s, "/api/runner/claim", { body: { maxConcurrent: 1, activeIds: [] } })).status).toBe(401);
  });
});

async function fetchRunnerNoAuth(path: string, body: unknown) {
  const { call } = await import("./helpers.ts");
  return call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("W10 claim", () => {
  let s: TestSession;
  let r: TestRunner;
  beforeEach(async () => {
    s = await login();
    r = await registerRunner();
    await clearQueue();
  });

  it("古い順に 1 件ずつ、attempt を +1 して running に", async () => {
    const now = Date.now();
    const newer = await insertInstruction(s.userId, { createdAt: now - 1000 });
    const older = await insertInstruction(s.userId, { createdAt: now - 5000 });
    const first = await claim(r);
    expect(first?.instruction.id).toBe(older);
    expect(first?.instruction.status).toBe("running");
    expect(first?.instruction.attempt).toBe(1);
    expect(first?.resume).toBe(false);
    const row = await env.DB.prepare("SELECT lease_runner_id, lease_expires_at FROM instructions WHERE id = ?").bind(older).first<{ lease_runner_id: string; lease_expires_at: number }>();
    expect(row?.lease_runner_id).toBe(r.runnerId);
    expect(row!.lease_expires_at).toBeGreaterThan(now + 9 * 60_000);
    const second = await claim(r, [older]);
    expect(second?.instruction.id).toBe(newer);
    expect(await claim(r, [older, newer], 4)).toBeNull();
  });

  it("activeIds が maxConcurrent 以上なら 204", async () => {
    await insertInstruction(s.userId);
    const res = await runner(r, "/api/runner/claim", { body: { maxConcurrent: 1, activeIds: [crypto.randomUUID()] } });
    expect(res.status).toBe(204);
  });

  it("not_before が未来のものは飛ばす", async () => {
    const now = Date.now();
    const later = await insertInstruction(s.userId, { createdAt: now - 9000, notBefore: now + 60_000 });
    const ready = await insertInstruction(s.userId, { createdAt: now - 1000, notBefore: now - 1 });
    expect((await claim(r))?.instruction.id).toBe(ready);
    expect(await claim(r, [ready])).toBeNull();
    expect(await statusOf(later)).toBe("queued");
  });

  it("lease 切れの running を取り直す（resume=true、attempt は 2）", async () => {
    const other = await registerRunner();
    const now = Date.now();
    const id = await insertInstruction(s.userId, { status: "running", leaseRunnerId: other.runnerId, leaseExpiresAt: now - 1 });
    await env.DB.prepare("UPDATE instructions SET attempt = 1 WHERE id = ?").bind(id).run();
    await env.DB.prepare("INSERT INTO tasks (id, instruction_id, kind, title, seq, created_at, updated_at) VALUES (?, ?, 'plan', 'p', 0, 0, 0)").bind(crypto.randomUUID(), id).run();
    const live = await insertInstruction(s.userId, { status: "running", leaseRunnerId: other.runnerId, leaseExpiresAt: now + 60_000, createdAt: now - 99_999_999 });
    const c = await claim(r);
    expect(c?.instruction.id).toBe(id);
    expect(c?.resume).toBe(true);
    expect(c?.instruction.attempt).toBe(2);
    expect(await statusOf(live)).toBe("running");
    // 取り上げられた側の書き込みは 409
    const res = await runner(other, "/api/runner/events", { body: { instructionId: id, events: [{ taskId: null, agentId: null, seq: 0, kind: "note", content: "x" }] } });
    expect(res.status).toBe(409);
  });

  it("同時に 2 つの claim が来ても 1 件は 1 ランナーにだけ渡る", async () => {
    const r2 = await registerRunner();
    const id = await insertInstruction(s.userId);
    const results = await Promise.all([claim(r), claim(r2), claim(r), claim(r2)]);
    const got = results.filter((x) => x !== null);
    expect(got).toHaveLength(1);
    expect(got[0]!.instruction.id).toBe(id);
    const t = await env.DB.prepare("SELECT count(*) AS n FROM status_transitions WHERE instruction_id = ? AND action = 'claim'").bind(id).first<{ n: number }>();
    expect(t?.n).toBe(1);
  });

  it("claim の出力に feedback が入る", async () => {
    const id = await insertInstruction(s.userId);
    await env.DB.prepare("UPDATE instructions SET feedback = '表を足して' WHERE id = ?").bind(id).run();
    expect((await claim(r))?.instruction.feedback).toBe("表を足して");
  });
});

describe("W11 lease を持たないランナーの書き込みは 409", () => {
  it("すべてのランナー用状態変更 API", async () => {
    const s = await login();
    const holder = await registerRunner();
    const intruder = await registerRunner();
    const id = await claimed(s, holder);
    const queuedId = await insertInstruction(s.userId, { createdAt: Date.now() + 10 });
    const calls: [string, string, unknown][] = [
      ["GET", `/api/runner/instructions/${id}/state`, undefined],
      ["PATCH", `/api/runner/instructions/${id}`, { title: "x" }],
      ["POST", `/api/runner/instructions/${id}/release`, { reason: "error", notBefore: null }],
      ["POST", "/api/runner/projects", { instructionId: id, name: "n", slug: "nope", summary: "", leader: { name: "l", specialty: "" }, members: [{ name: "m", specialty: "" }] }],
      ["POST", "/api/runner/tasks", { tasks: [{ instructionId: id, parentTaskId: null, assigneeAgentId: null, kind: "plan", planKey: null, dependsOn: [], title: "p", spec: "", round: 1, seq: 0 }] }],
      ["POST", "/api/runner/events", { instructionId: id, events: [{ taskId: null, agentId: null, seq: 0, kind: "note", content: "x" }] }],
      ["POST", "/api/runner/artifacts", { instructionId: id, taskId: null, relPath: "a.md", title: "a", mime: "text/markdown", sizeBytes: 1, sha256: sha, previewText: null }],
      ["POST", "/api/runner/decisions", { instructionId: id, taskId: null, askedByAgentId: null, question: "q", options: [] }],
      ["POST", "/api/runner/ai/chat", { instructionId: id, role: "coo", messages: [{ role: "system", content: "ROLE: coo_route" }], maxCompletionTokens: 64 }],
      // queued（誰も握っていない）指示への書き込みも 409
      ["PATCH", `/api/runner/instructions/${queuedId}`, { title: "x" }],
    ];
    for (const [method, path, body] of calls) {
      const res = await runner(intruder, path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "conflict" } });
    }
    // CEO が取り消したら、握っていたランナーも 409
    await browser(s, `/api/instructions/${id}/transition`, { body: { action: "cancel", expectedStatus: "running" } });
    expect((await runner(holder, `/api/runner/instructions/${id}`, { method: "PATCH", body: { title: "x" } })).status).toBe(409);
  });

  it("タスクの PATCH も lease を見る", async () => {
    const s = await login();
    const holder = await registerRunner();
    const intruder = await registerRunner();
    const id = await claimed(s, holder);
    const created = await runner(holder, "/api/runner/tasks", {
      body: { tasks: [{ instructionId: id, parentTaskId: null, assigneeAgentId: null, kind: "plan", planKey: null, dependsOn: [], title: "計画", spec: "", round: 1, seq: 0 }] },
    });
    const task = ((await created.json()) as { items: Task[] }).items[0]!;
    expect((await runner(intruder, `/api/runner/tasks/${task.id}`, { method: "PATCH", body: { status: "done" } })).status).toBe(409);
  });
});

describe("W12 判断", () => {
  it("作成で needs_decision と lease 解除、回答で queued、二重回答は 409", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    const res = await runner(r, "/api/runner/decisions", {
      body: { instructionId: id, taskId: null, askedByAgentId: "agent-coo", question: "どちらにしますか", options: ["A案", "B案"] },
    });
    expect(res.status).toBe(201);
    const decision = (await res.json()) as Decision;
    expect(decision).toMatchObject({ status: "open", options: ["A案", "B案"], instructionId: id });
    const row = await env.DB.prepare("SELECT status, lease_runner_id, lease_expires_at FROM instructions WHERE id = ?").bind(id).first();
    expect(row).toEqual({ status: "needs_decision", lease_runner_id: null, lease_expires_at: null });
    // 判断待ちの間は claim されない
    expect((await runner(r, "/api/runner/claim", { body: { maxConcurrent: 2, activeIds: [] } })).status).toBe(204);
    // 一覧には openDecisionId
    const detail = (await (await browser(s, `/api/instructions/${id}`)).json()) as { instruction: InstructionSummary };
    expect(detail.instruction.openDecisionId).toBe(decision.id);

    const answer = await browser(s, `/api/decisions/${decision.id}/answer`, { body: { answer: "A案", optionIndex: 0 } });
    expect(answer.status).toBe(200);
    const out = (await answer.json()) as { decision: Decision; instruction: InstructionSummary };
    expect(out.decision).toMatchObject({ status: "answered", answer: "A案" });
    expect(out.instruction).toMatchObject({ status: "queued", openDecisionId: null });

    const again = await browser(s, `/api/decisions/${decision.id}/answer`, { body: { answer: "B案" } });
    expect(again.status).toBe(409);

    // 再 claim で state に回答済みの判断が入る
    const c = await claim(r);
    expect(c?.instruction.id).toBe(id);
    const state = RunnerInstructionState.parse(await (await runner(r, `/api/runner/instructions/${id}/state`)).json());
    expect(state.decisions).toMatchObject([{ status: "answered", answer: "A案" }]);
  });

  it("1 指示 3 回まで。4 回目は 400", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    for (let n = 0; n < 3; n++) {
      const d = await runner(r, "/api/runner/decisions", { body: { instructionId: id, taskId: null, askedByAgentId: null, question: `q${n}`, options: [] } });
      expect(d.status).toBe(201);
      const dec = (await d.json()) as Decision;
      await browser(s, `/api/decisions/${dec.id}/answer`, { body: { answer: "はい" } });
      await claim(r);
    }
    const fourth = await runner(r, "/api/runner/decisions", { body: { instructionId: id, taskId: null, askedByAgentId: null, question: "q4", options: [] } });
    expect(fourth.status).toBe(400);
    expect(await statusOf(id)).toBe("running");
  });

  it("空の回答は 400、存在しない判断は 404", async () => {
    const s = await login();
    expect((await browser(s, `/api/decisions/${crypto.randomUUID()}/answer`, { body: { answer: "x" } })).status).toBe(404);
    expect((await browser(s, `/api/decisions/${crypto.randomUUID()}/answer`, { body: { answer: "  " } })).status).toBe(400);
  });
});

describe("W13 イベント", () => {
  it("重複 seq は無視される（冪等）。lastSeq は最大の seq", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    const ev = (seq: number, content: unknown) => ({ taskId: null, agentId: "agent-coo", seq, kind: "note", content });
    const a = await runner(r, "/api/runner/events", { body: { instructionId: id, events: [ev(0, "最初"), ev(1, { a: 1 })] } });
    expect(await a.json()).toEqual({ lastSeq: 1 });
    const b = await runner(r, "/api/runner/events", { body: { instructionId: id, events: [ev(1, "上書きしない"), ev(2, "次")] } });
    expect(await b.json()).toEqual({ lastSeq: 2 });
    const list = (await (await browser(s, `/api/instructions/${id}/events?after=-1`)).json()) as { items: { seq: number; content: unknown }[] };
    expect(list.items.map((e) => [e.seq, e.content])).toEqual([
      [0, "最初"],
      [1, { a: 1 }],
      [2, "次"],
    ]);
    const after = (await (await browser(s, `/api/instructions/${id}/events?after=0&limit=1`)).json()) as { items: { seq: number }[] };
    expect(after.items.map((e) => e.seq)).toEqual([1]);
    const state = RunnerInstructionState.parse(await (await runner(r, `/api/runner/instructions/${id}/state`)).json());
    expect(state.nextEventSeq).toBe(3);
  });

  it("16KB を超える content は切って保存する。51 件は 400", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    await runner(r, "/api/runner/events", { body: { instructionId: id, events: [{ taskId: null, agentId: null, seq: 0, kind: "tool_result", content: "x".repeat(20_000) }] } });
    const row = await env.DB.prepare("SELECT content FROM agent_events WHERE instruction_id = ?").bind(id).first<{ content: string }>();
    expect(JSON.parse(row!.content)).toMatchObject({ truncated: true });
    expect(row!.content.length).toBeLessThan(16_200);
    const many = Array.from({ length: 51 }, (_, n) => ({ taskId: null, agentId: null, seq: n + 1, kind: "note", content: n }));
    expect((await runner(r, "/api/runner/events", { body: { instructionId: id, events: many } })).status).toBe(400);
  });
});

describe("ランナーの進行（state・プロジェクト・タスク・成果物・PATCH・release・heartbeat）", () => {
  it("正常の流れで review まで進む", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r, "新しい調査をして");

    let state = RunnerInstructionState.parse(await (await runner(r, `/api/runner/instructions/${id}/state`)).json());
    expect(state).toMatchObject({ routed: false, nextEventSeq: 0, project: null, coo: { id: "agent-coo", role: "coo" }, tasks: [] });

    // 既存の slug と衝突させる
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (?, 'test', '既存', ?, ?)").bind(crypto.randomUUID(), now, now),
      env.DB.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (?, 'test-2', '既存2', ?, ?)").bind(crypto.randomUUID(), now, now),
    ]);
    const pRes = await runner(r, "/api/runner/projects", {
      body: {
        instructionId: id,
        name: "テスト",
        slug: "test",
        summary: "要約",
        leader: { name: "リーダー", specialty: "まとめ" },
        members: [
          { name: "調査担当", specialty: "調べる" },
          { name: "執筆担当", specialty: "書く" },
        ],
      },
    });
    expect(pRes.status).toBe(201);
    // 既存プロジェクトが COO に見える（D-33）
    const withProjects = RunnerInstructionState.parse(await (await runner(r, `/api/runner/instructions/${id}/state`)).json());
    expect(withProjects.activeProjects?.map((p) => p.slug).sort()).toEqual(["test", "test-2", "test-3"]);
    const project = ProjectWithTeamSchema.parse(await pRes.json());
    expect(project.slug).toBe("test-3");
    expect(project.agents.map((a) => [a.role, a.name])).toEqual([
      ["leader", "リーダー"],
      ["member", "調査担当"],
      ["member", "執筆担当"],
    ]);

    const patch = await runner(r, `/api/runner/instructions/${id}`, { method: "PATCH", body: { title: "新しい調査", projectId: project.id } });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ title: "新しい調査", projectName: "テスト", status: "running" });

    await runner(r, "/api/runner/events", { body: { instructionId: id, events: [{ taskId: null, agentId: "agent-coo", seq: 0, kind: "action", content: { stage: "route", kind: "route" } }] } });

    // メンバーの追加は合計 3 体まで
    const add = await runner(r, `/api/runner/projects/${project.id}/agents`, { body: { instructionId: id, agents: [{ role: "member", name: "校正担当", specialty: "校正" }] } });
    expect(add.status).toBe(201);
    const tooMany = await runner(r, `/api/runner/projects/${project.id}/agents`, { body: { instructionId: id, agents: [{ role: "member", name: "4 人目", specialty: "" }] } });
    expect(tooMany.status).toBe(409);

    const leader = project.agents.find((a) => a.role === "leader")!;
    const member = project.agents.find((a) => a.name === "調査担当")!;
    const planId = crypto.randomUUID();
    const plan = { id: planId, instructionId: id, parentTaskId: null, assigneeAgentId: leader.id, kind: "plan", planKey: null, dependsOn: [], title: "計画", spec: "", round: 1, seq: 0 };
    const work = { id: crypto.randomUUID(), instructionId: id, parentTaskId: planId, assigneeAgentId: member.id, kind: "work", planKey: "t1", dependsOn: [], title: "調べる", spec: "s", round: 1, seq: 1 };
    const tRes = await runner(r, "/api/runner/tasks", { body: { tasks: [plan, work] } });
    expect(tRes.status).toBe(201);
    const tasks = ((await tRes.json()) as { items: Task[] }).items;
    expect(tasks.map((t) => t.kind)).toEqual(["plan", "work"]);
    // 同じものの再送は既存を返す（増えない）
    const again = (await (await runner(r, "/api/runner/tasks", { body: { tasks: [plan, { ...work, id: crypto.randomUUID() }] } })).json()) as { items: Task[] };
    expect(again.items.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
    const count = await env.DB.prepare("SELECT count(*) AS n FROM tasks WHERE instruction_id = ?").bind(id).first<{ n: number }>();
    expect(count?.n).toBe(2);
    // 存在しない担当者は 400
    const bad = await runner(r, "/api/runner/tasks", { body: { tasks: [{ ...work, id: crypto.randomUUID(), planKey: "t9", assigneeAgentId: "nobody" }] } });
    expect(bad.status).toBe(400);

    const running = await runner(r, `/api/runner/tasks/${work.id}`, { method: "PATCH", body: { status: "running" } });
    expect(((await running.json()) as Task).startedAt).not.toBeNull();
    const done = await runner(r, `/api/runner/tasks/${work.id}`, { method: "PATCH", body: { status: "done", resultSummary: "調べた" } });
    expect(await done.json()).toMatchObject({ status: "done", resultSummary: "調べた" });

    const art = { instructionId: id, taskId: work.id, relPath: "notes/t1.md", title: "メモ", mime: "text/markdown", sizeBytes: 10, sha256: sha, previewText: "# t1" };
    const a1 = await runner(r, "/api/runner/artifacts", { body: art });
    expect(a1.status).toBe(201);
    const artifact = ArtifactSchema.parse(await a1.json());
    expect(artifact.projectSlug).toBe("test-3");
    const a2 = await runner(r, "/api/runner/artifacts", { body: art });
    expect(a2.status).toBe(200);
    expect(((await a2.json()) as { id: string }).id).toBe(artifact.id);
    const viewed = await browser(s, `/api/artifacts/${artifact.id}`);
    expect(await viewed.json()).toMatchObject({ previewText: "# t1", relPath: "notes/t1.md" });

    state = RunnerInstructionState.parse(await (await runner(r, `/api/runner/instructions/${id}/state`)).json());
    expect(state).toMatchObject({ routed: true, nextEventSeq: 1, project: { id: project.id }, instruction: { title: "新しい調査" } });
    expect(state.tasks).toHaveLength(2);

    const fin = await runner(r, `/api/runner/instructions/${id}`, { method: "PATCH", body: { status: "review", resultSummary: "テスト報告" } });
    expect(await fin.json()).toMatchObject({ status: "review", resultSummary: "テスト報告", taskCounts: { total: 1, done: 1 } });
    const row = await env.DB.prepare("SELECT lease_runner_id FROM instructions WHERE id = ?").bind(id).first<{ lease_runner_id: string | null }>();
    expect(row?.lease_runner_id).toBeNull();

    const projects = (await (await browser(s, "/api/projects")).json()) as { items: { slug: string; agents: unknown[] }[] };
    expect(projects.items.find((p) => p.slug === "test-3")?.agents).toHaveLength(4);
  });

  it("release で queued に戻り、not_before が付く", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    const notBefore = Date.now() + 3_600_000;
    const res = await runner(r, `/api/runner/instructions/${id}/release`, { body: { reason: "ai_quota", notBefore } });
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT status, not_before, lease_runner_id FROM instructions WHERE id = ?").bind(id).first();
    expect(row).toEqual({ status: "queued", not_before: notBefore, lease_runner_id: null });
    expect(await claim(r)).toBeNull();
  });

  it("failed にすると error が入る", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    const res = await runner(r, `/api/runner/instructions/${id}`, { method: "PATCH", body: { status: "failed", error: "上限: AI 呼び出し回数" } });
    expect(await res.json()).toMatchObject({ status: "failed", error: "上限: AI 呼び出し回数" });
  });

  it("heartbeat は lease を延ばし、握っていない指示を cancelInstructionIds で返す", async () => {
    const s = await login();
    const r = await registerRunner();
    const id = await claimed(s, r);
    await env.DB.prepare("UPDATE instructions SET lease_expires_at = ? WHERE id = ?").bind(Date.now() + 1000, id).run();
    const gone = crypto.randomUUID();
    const res = await runner(r, "/api/runner/heartbeat", {
      body: { version: "0.1.0", tailnetUrl: "https://rikumac-mini.tail6eb659.ts.net", activeInstructionIds: [id, gone], maxConcurrent: 2 },
    });
    expect(res.status).toBe(200);
    const out = HeartbeatOutput.parse(await res.json());
    expect(out.cancelInstructionIds).toEqual([gone]);
    const row = await env.DB.prepare("SELECT lease_expires_at FROM instructions WHERE id = ?").bind(id).first<{ lease_expires_at: number }>();
    expect(row!.lease_expires_at).toBeGreaterThan(Date.now() + 9 * 60_000);
    const info = (await (await browser(s, "/api/session")).json()) as { runner: Record<string, unknown> };
    expect(info.runner).toMatchObject({ online: true, version: "0.1.0", activeInstructionIds: [id, gone], tailnetUrl: "https://rikumac-mini.tail6eb659.ts.net" });

    // CEO が取り消したら次のハートビートで中止を伝える
    await browser(s, `/api/instructions/${id}/transition`, { body: { action: "cancel", expectedStatus: "running" } });
    const res2 = await runner(r, "/api/runner/heartbeat", { body: { version: "0.1.0", tailnetUrl: null, activeInstructionIds: [id], maxConcurrent: 2 } });
    expect(HeartbeatOutput.parse(await res2.json()).cancelInstructionIds).toEqual([id]);
  });
});
