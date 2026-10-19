// R10 429 ai_quota で release(notBefore)。
import { afterEach, describe, expect, it } from "vitest";
import { nextUtcMidnight } from "../src/orchestrator/run.ts";
import { toApiError } from "../src/api.ts";
import { isStage, normalRules, quotaError } from "./fakes/fake-ai.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(() => env?.cleanup());

describe("R10 AI の枠切れ", () => {
  it("429 ai_quota を受けたら release { reason: ai_quota, notBefore: retryAt } で queued に戻す", async () => {
    const retryAt = Date.now() + 60_000;
    env = await makeEnv({ rules: [...normalRules().slice(0, 1), { match: isStage("leader_plan"), reply: { error: quotaError(retryAt) } }] });
    const id = env.api.addInstruction("[quota]");
    expect((await env.claimAndRun()).outcome).toBe("released");
    expect(env.api.releases).toEqual([{ instructionId: id, input: { reason: "ai_quota", notBefore: retryAt } }]);
    const inst = env.api.inst(id);
    expect(inst.status).toBe("queued");
    expect(inst.notBefore).toBe(retryAt);
    // 再試行しない（429 は 1 回だけ）
    expect(env.ai.callsFor("leader_plan")).toHaveLength(1);
    // notBefore が未来なので、すぐには取り出されない
    expect(await env.api.claim({ maxConcurrent: 2, activeIds: [] })).toBeNull();
  });

  it("retryAt が無ければ次の UTC 0 時", async () => {
    env = await makeEnv({ rules: [{ match: isStage("coo_route"), reply: { error: toApiError(429, { error: { code: "ai_quota", message: "quota" } }) } }] });
    env.api.addInstruction("x");
    const before = Date.now();
    await env.claimAndRun();
    const nb = env.api.releases[0]?.input.notBefore ?? 0;
    expect(nb).toBe(nextUtcMidnight(before));
    expect(new Date(nb).getUTCHours()).toBe(0);
  });

  it("枠が戻ったら続きから（振り分けをやり直さない）", async () => {
    let quota = true;
    env = await makeEnv({
      rules: [
        ...normalRules().slice(0, 1),
        { match: isStage("leader_plan", () => quota), reply: { error: quotaError(Date.now() - 1) } },
        ...normalRules().slice(1),
      ],
    });
    const id = env.api.addInstruction("x");
    expect((await env.claimAndRun()).outcome).toBe("released");
    quota = false;
    expect((await env.claimAndRun()).outcome).toBe("review");
    expect(env.ai.callsFor("coo_route")).toHaveLength(1);
    expect(env.api.inst(id).status).toBe("review");
  });

  it("メンバーの途中で枠切れになっても release する（他のメンバーも止める）", async () => {
    const retryAt = Date.now() + 1000;
    env = await makeEnv({
      rules: [{ match: isStage("member_step", (i) => /TASK_KEY: t2/.test(i.messages[1]!.content)), reply: { error: quotaError(retryAt) } }, ...normalRules()],
    });
    const id = env.api.addInstruction("x");
    expect((await env.claimAndRun()).outcome).toBe("released");
    expect(env.api.releases[0]?.input).toEqual({ reason: "ai_quota", notBefore: retryAt });
    expect(env.api.inst(id).status).toBe("queued");
  });
});
