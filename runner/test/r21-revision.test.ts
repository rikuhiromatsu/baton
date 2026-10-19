// R21 版と話し中の保留（4.6・D-79）: COO の present・relay は見ていた版を持ち、古ければ行わず [知らせ]。
// CEO がリーダーと話している間はそのプロジェクトの present・relay を保留し、リーダーのターンが終わってから見直させる。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { executeCooActions } from "../src/orchestrator/actions.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

/** リーダーの report が COO の受信箱に入るところまで進める */
async function toWorkReport(e: Env): Promise<string> {
  e.api.ceoSays(COO_THREAD_ID, "何か作って");
  for (let i = 0; i < 10 && !e.api.pendingInbox(COO_THREAD_ID).some((x) => x.kind === "work_report"); i++) await e.step();
  const id = [...e.api.instructions.values()][0]!.id;
  expect(e.api.pendingInbox(COO_THREAD_ID).some((x) => x.kind === "work_report")).toBe(true);
  return id;
}

describe("R21 版と保留", () => {
  it("版が古い present は行わず、COO の受信箱に [知らせ]「方針が変わった（rev 2）」", async () => {
    env = await makeEnv();
    const id = await toWorkReport(env);
    env.api.instr(id).revision = 2; // CEO がリーダーと話して版が上がった
    const r = await executeCooActions(env.ctx, {
      threadId: COO_THREAD_ID,
      messageId: "m",
      agentId: "agent-coo",
      actions: [{ type: "present", instructionId: id, revision: 1, summary: "古い報告" }],
      context: { recentMessages: [], openInstructions: [{ id, title: "t", status: "running", phase: "coo", revision: 1, projectId: env.api.instr(id).projectId, talkingWithCeo: false }], projects: [], repos: [], talkingProjectIds: [], viewing: null },
      secretary: false,
      inbox: [],
    });
    expect(r.kind).toBe("chat");
    expect(env.api.instr(id).status).toBe("running");
    const n = env.api.pendingInbox(COO_THREAD_ID).find((i) => i.kind === "instruction_event")!;
    expect(String(n.payload.text)).toContain("方針が変わった（rev 2）");
    // 次の COO のターンの入力に [知らせ] として入る
    await env.step();
    const input = env.api.transcript.filter((t) => t.kind === "user").at(-1)!;
    expect(String((input.body as { text: string }).text)).toContain("[知らせ] 方針が変わった（rev 2）");
  }, 30_000);

  it("話し中は保留 → リーダーのターンが終わると COO を起こし、版を見直して present", async () => {
    env = await makeEnv();
    const id = await toWorkReport(env);
    const projectId = env.api.instr(id).projectId!;
    env.api.talking.add(projectId);
    await env.step(); // COO: present を保留
    expect(env.api.instr(id).status).toBe("running");
    expect(env.ctx.coord.heldProjects.has(projectId)).toBe(true);
    expect(env.api.agentMessages(COO_THREAD_ID).some((m) => m.kind === "report")).toBe(false);
    // CEO がリーダーとの話を終え、リーダーのターン（報告など）が終わる
    env.api.talking.delete(projectId);
    await env.api.pushInbox(`thread-${projectId}`, { kind: "instruction_event", wakes: true, payload: { text: "会話が終わりました" } });
    await env.step(); // リーダー
    expect(env.ctx.coord.heldProjects.has(projectId)).toBe(false);
    expect(env.api.pendingInbox(COO_THREAD_ID).some((i) => i.wakes && String(i.payload.text ?? "").includes("保留していた"))).toBe(true);
  }, 30_000);
});
