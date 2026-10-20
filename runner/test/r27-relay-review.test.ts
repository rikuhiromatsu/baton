// R27 確認の指示を COO が relay（CEO の差し戻しを COO スレッドで受けた）→ リーダーが plan でやり直す（4.4）。
// 本番で、リーダーのターンの始まりに確認の指示を running にしてしまい、plan の reopen が 409（cannot reopen）で落ちて
// タスクが作られないまま running で止まった。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { executeCooActions, executeLeaderActions } from "../src/orchestrator/actions.ts";
import type { ThreadClaim } from "../src/orchestrator/thread.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

/** 依頼から確認（review）まで進める */
async function toReview(e: Env): Promise<string> {
  e.api.ceoSays(COO_THREAD_ID, "何か作って");
  await e.drain();
  const id = [...e.api.instructions.values()][0]!.id;
  expect(e.api.instr(id).status).toBe("review");
  return id;
}

describe("R27 確認の指示の relay", () => {
  it("relay でリーダーが起きても確認のままにし、リーダーの plan が reopen してラウンド 2 のタスクを作る", async () => {
    env = await makeEnv();
    const { api } = env;
    const id = await toReview(env);
    const projectId = api.instr(id).projectId!;
    const tasksBefore = api.tasks.size;
    await executeCooActions(env.ctx, {
      threadId: COO_THREAD_ID,
      messageId: "m",
      agentId: "agent-coo",
      actions: [{ type: "relay", instructionId: id, revision: api.instr(id).revision, message: "CEO から差し戻しです。もっとニッチに" }],
      context: { recentMessages: [], openInstructions: [{ id, title: "t", status: "review", phase: "coo", revision: api.instr(id).revision, projectId, talkingWithCeo: false }], projects: [], repos: [], talkingProjectIds: [], viewing: null },
      secretary: false,
      inbox: [],
    });
    const r = await env.step(); // リーダー: plan
    expect(r?.kind).toBe("thread");
    expect(api.instr(id).status).toBe("running");
    expect(api.instr(id).phase).toBe("members");
    expect(api.tasks.size).toBeGreaterThan(tasksBefore);
    expect([...api.tasks.values()].some((t) => t.instructionId === id && t.round === 2)).toBe(true);
    expect(api.messagesOf(`thread-${projectId}`).some((m) => m.body.includes("行えませんでした"))).toBe(false);
  }, 30_000);

  it("文脈では確認でも、すでに running なら plan の reopen の 409 を越えてタスクを作る", async () => {
    env = await makeEnv();
    const { api } = env;
    const id = await toReview(env);
    const projectId = api.instr(id).projectId!;
    api.instr(id).status = "running"; // 文脈を作った後に、別のターンが reopen した
    const tasksBefore = api.tasks.size;
    const t = api.threads.get(`thread-${projectId}`)!;
    await executeLeaderActions(env.ctx, {
      thread: { ...t, lastSeq: 0 } as unknown as ThreadClaim["thread"],
      project: api.projects.get(projectId)!,
      messageId: "m",
      value: { reply: "やり直します", awaitingReply: false, actions: [{ type: "plan", instructionId: id, newTitle: null, tasks: [{ key: "t9", title: "やり直し", spec: "やり直す", assignee: "リサーチ", dependsOn: [], paths: [] }] }], cooReport: null },
      context: { recentMessages: [], openInstructions: [{ id, title: "t", status: "review", phase: "coo", revision: 1, projectId, talkingWithCeo: false }], projects: [], repos: [], talkingProjectIds: [], viewing: null },
      inbox: [],
      hasCeo: false,
    } as Parameters<typeof executeLeaderActions>[1]);
    expect(api.tasks.size).toBe(tasksBefore + 1);
    expect(api.instr(id).phase).toBe("members");
    expect(api.messagesOf(`thread-${projectId}`).some((m) => m.body.includes("行えませんでした"))).toBe(false);
  }, 30_000);
});
