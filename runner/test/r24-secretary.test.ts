// R24 秘書の発言のターン（11.5・D-91）: COO が delegate・propose_project を返してもランナーが行わない。CEO への確認の発言だけ残す。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID, type CooAction } from "@baton/shared";
import { executeCooActions } from "../src/orchestrator/actions.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R24 秘書", () => {
  it("偽 claude: 秘書の「新しいプロジェクトを始めて」で立てずに CEO に確かめる", async () => {
    env = await makeEnv();
    env.api.secretarySays("新しいプロジェクトを始めて");
    await env.step();
    expect(env.api.projects.size).toBe(0);
    expect(env.api.instructions.size).toBe(0);
    expect(env.api.agentMessages(COO_THREAD_ID).at(-1)!.body).toContain("CEO に確かめます");
  }, 30_000);

  it("COO がプロンプトを守らず delegate・propose_project を返しても、ランナーは行わない（relay などは行う）", async () => {
    env = await makeEnv();
    const actions: CooAction[] = [
      { type: "delegate", title: "x", project: { mode: "new", name: "x", slug: "xx", goal: "g", summary: "", leader: { name: "l", specialty: "" }, members: [{ name: "m", specialty: "", profile: "writer" }] }, brief: "b" },
      { type: "propose_project", name: "x", slug: "xy", goal: "g", summary: "", workspace: { kind: "baton" }, leader: { name: "l", specialty: "" }, members: [{ name: "m", specialty: "", profile: "writer" }] },
    ];
    const r = await executeCooActions(env.ctx, {
      threadId: COO_THREAD_ID,
      messageId: "m1",
      agentId: "agent-coo",
      actions,
      context: { recentMessages: [], openInstructions: [], projects: [], repos: [], talkingProjectIds: [], viewing: null },
      secretary: true,
      inbox: [],
    });
    expect(r.acted).toBe(false);
    expect(env.api.projects.size).toBe(0);
    expect(env.api.proposals).toHaveLength(0);
    expect(env.api.instructions.size).toBe(0);
  });
});
