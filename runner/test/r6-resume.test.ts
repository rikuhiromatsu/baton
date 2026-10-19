// R6 途中で落ちた想定（work 1 つ running のまま）から再開して、done の work を実行しない。
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Task } from "@baton/shared";
import { afterEach, describe, expect, it } from "vitest";
import { decideResume } from "../src/orchestrator/resume.ts";
import { firstUser, normalRules, stageOf, taskKeyOf } from "./fakes/fake-ai.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(() => env?.cleanup());

function task(over: Partial<Task> & Pick<Task, "instructionId" | "kind">): Task {
  return {
    id: randomUUID(),
    parentTaskId: null,
    assigneeAgentId: null,
    planKey: null,
    dependsOn: [],
    title: "t",
    spec: "",
    status: "pending",
    resultSummary: null,
    round: 1,
    seq: 0,
    startedAt: null,
    finishedAt: null,
    updatedAt: 0,
    ...over,
  };
}

/** route 済み・plan done・t1 done・t2 running（落ちた）の状態を作る */
async function crashedState(env: Env): Promise<{ id: string; t1: Task; t2: Task }> {
  const id = env.api.addInstruction("途中で落ちた指示", { title: "落ちた指示" });
  // プロジェクト（Worker が作ったもの）
  const projectId = randomUUID();
  const leader = { id: randomUUID(), projectId, role: "leader" as const, name: "リーダー", specialty: "まとめ", model: null, active: true };
  const m1 = { id: randomUUID(), projectId, role: "member" as const, name: "調査担当", specialty: "調べもの", model: null, active: true };
  const m2 = { id: randomUUID(), projectId, role: "member" as const, name: "執筆担当", specialty: "文章", model: null, active: true };
  env.api.projects.push({ id: projectId, slug: "test", name: "テスト", summary: "s", status: "active", agents: [leader, m1, m2], updatedAt: 0 });
  env.api.inst(id).projectId = projectId;
  await mkdir(path.join(env.dataDir, "projects/test/notes"), { recursive: true });
  await writeFile(path.join(env.dataDir, "projects/test/notes/t1.md"), "t1 の本文");

  const plan = task({ instructionId: id, kind: "plan", status: "done", assigneeAgentId: leader.id, spec: "方針", seq: 0 });
  const t1 = task({ instructionId: id, kind: "work", planKey: "t1", parentTaskId: plan.id, assigneeAgentId: m1.id, title: "調査", status: "done", resultSummary: "調べた\n\n成果物:\n- notes/t1.md（メモ t1）", seq: 1 });
  const t2 = task({ instructionId: id, kind: "work", planKey: "t2", parentTaskId: plan.id, assigneeAgentId: m2.id, title: "執筆", status: "running", seq: 2 });
  env.api.tasks.push(plan, t1, t2);
  env.api.events.push(
    { instructionId: id, taskId: null, agentId: "agent-coo", seq: 0, kind: "action", content: { stage: "route", action: { kind: "route" } } },
    { instructionId: id, taskId: plan.id, agentId: leader.id, seq: 1, kind: "action", content: { stage: "plan" } },
    { instructionId: id, taskId: t2.id, agentId: m2.id, seq: 2, kind: "llm_call", content: {} },
  );
  // ランナーが落ちて lease が切れた running の指示
  const inst = env.api.inst(id);
  inst.status = "running";
  inst.leaseRunnerId = "dead-runner";
  inst.leaseExpiresAt = 1;
  inst.attempt = 1;
  return { id, t1, t2 };
}

describe("R6 再開", () => {
  it("lease 切れを取り直し、done の work は実行せず running の work だけやり直す", async () => {
    env = await makeEnv({ rules: normalRules() });
    const { id, t1, t2 } = await crashedState(env);
    const claim = await env.api.claim({ maxConcurrent: 2, activeIds: [] });
    expect(claim?.instruction.id).toBe(id);
    expect(claim?.resume).toBe(true);
    expect(claim?.instruction.attempt).toBe(2);
    const { runInstruction } = await import("../src/orchestrator/run.ts");
    expect(await runInstruction(env.deps, claim!, new AbortController().signal)).toBe("review");

    expect(env.ai.calls.map(stageOf)).toEqual(["member_step", "member_step", "leader_review", "coo_final"]);
    expect(env.ai.callsFor("member_step").every((c) => taskKeyOf(c) === "t2")).toBe(true);
    // t1 は触らない
    const t1Calls = env.api.calls.filter((c) => c.method === "patchTask");
    expect(env.api.tasks.find((t) => t.id === t1.id)?.status).toBe("done");
    expect(env.api.tasks.find((t) => t.id === t1.id)?.startedAt).toBeNull();
    expect(t1Calls.length).toBeGreaterThan(0);
    expect(env.api.tasks.find((t) => t.id === t2.id)?.status).toBe("done");
    // t2 のプロンプトに t1 の結果は入らない（依存していないので）が、まとめには両方
    expect(firstUser(env.ai.callsFor("leader_review")[0]!)).toMatch(/t1「調査」.*完了/);
    // 最終報告の成果物一覧に、再開前の t1 の成果物も入る
    expect(firstUser(env.ai.callsFor("coo_final")[0]!)).toContain("notes/t1.md（メモ t1）");
    // seq は 3 から続く
    const seqs = env.api.eventsOf(id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(env.api.inst(id).status).toBe("review");
  });

  it("revise の途中で落ちても、やり直しを飛ばさずラウンド 2 から続ける", async () => {
    const { J, isStage, memberDone, memberWrite, hasToolResult, reviewReport } = await import("./fakes/fake-ai.ts");
    const revise = J({ kind: "revise", reason: "足りない", tasks: [{ key: "t1", title: "追加", spec: "notes/t1.md", assignee: "調査担当", dependsOn: [] }] });
    env = await makeEnv({
      rules: [
        { match: isStage("leader_review"), reply: revise },
        { match: isStage("member_step", (i) => taskKeyOf(i) === "t1" && !hasToolResult(i)), reply: memberWrite("t1"), times: 2 },
        { match: isStage("member_step", (i) => taskKeyOf(i) === "t1"), reply: memberDone("t1"), times: 2 },
        { match: isStage("leader_review"), reply: reviewReport },
        ...normalRules().filter((r) => r.name !== "review" && !r.name?.startsWith("t1")),
      ],
    });
    const id = env.api.addInstruction("やり直しの途中で落ちる");
    // ラウンド 2 の work を作った直後（まとめを done にする前）に落ちる
    let creates = 0;
    const orig = env.api.createTasks.bind(env.api);
    env.api.createTasks = async (input, opts) => {
      const out = await orig(input, opts);
      if (input.tasks.some((t) => t.round === 2 && t.kind === "work") && creates++ === 0) throw new Error("落ちた");
      return out;
    };
    expect((await env.claimAndRun()).outcome).toBe("failed");
    // 失敗にした指示を CEO が再実行した想定で queued に戻す
    const inst = env.api.inst(id);
    inst.status = "queued";
    expect((await env.claimAndRun()).outcome).toBe("review");
    const round2 = env.api.tasksOf(id).filter((t) => t.round === 2);
    expect(round2.map((t) => `${t.kind}:${t.status}`).sort()).toEqual(["plan:done", "review:done", "work:done"]);
  });

  it("decideResume の分岐", async () => {
    env = await makeEnv();
    const { id } = await crashedState(env);
    env.api.inst(id).leaseRunnerId = env.api.runnerId;
    env.api.inst(id).leaseExpiresAt = Date.now() + 60_000;
    const state = await env.api.getState(id);
    expect(decideResume(state)).toEqual({ stage: "work", round: 1 });
    expect(decideResume({ ...state, routed: false })).toEqual({ stage: "route" });
    expect(decideResume({ ...state, instruction: { ...state.instruction, title: null } })).toEqual({ stage: "route" });
    const plan = state.tasks.find((t) => t.kind === "plan")!;
    expect(decideResume({ ...state, tasks: state.tasks.map((t) => (t.id === plan.id ? { ...t, status: "running" } : t)) })).toEqual({ stage: "plan", round: 1 });
    const allDone = state.tasks.map((t) => ({ ...t, status: "done" as const }));
    expect(decideResume({ ...state, tasks: allDone })).toEqual({ stage: "review", round: 1, reopen: false });
    const withReview = [...allDone, task({ instructionId: id, kind: "review", status: "done", seq: 3 })];
    expect(decideResume({ ...state, tasks: withReview })).toEqual({ stage: "final", round: 1 });
    expect(decideResume({ ...state, tasks: withReview, instruction: { ...state.instruction, feedback: "直して" } })).toEqual({ stage: "review", round: 1, reopen: true });
    expect(decideResume({ ...state, project: null, tasks: [] })).toEqual({ stage: "route" });
  });
});
