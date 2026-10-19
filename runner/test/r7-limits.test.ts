// R7 上限（AI 回数・トークン・ターン・時間）で failed。
import { afterEach, describe, expect, it } from "vitest";
import { J, isStage, normalRules } from "./fakes/fake-ai.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(() => env?.cleanup());

describe("R7 上限", () => {
  it("AI 呼び出し回数の上限で failed（error に「上限: 」）", async () => {
    env = await makeEnv({ limits: { aiCallsPerInstruction: 3 }, rules: normalRules() });
    const id = env.api.addInstruction("回数");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    const inst = env.api.inst(id);
    expect(inst.status).toBe("failed");
    expect(inst.error).toBe("上限: AI 呼び出し回数（3 回）");
    expect(env.ai.calls).toHaveLength(3);
  });

  it("トークンの上限で failed", async () => {
    env = await makeEnv({ limits: { tokensPerInstruction: 250 }, rules: normalRules() });
    const id = env.api.addInstruction("トークン");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    expect(env.api.inst(id).error).toMatch(/^上限: トークン/);
    expect(env.ai.calls).toHaveLength(2); // 150 + 150 = 300 ≥ 250 で 3 回目を呼ばない
  });

  it("Worker が指示のトークン上限で 429（scope=instruction）を返したら failed", async () => {
    const { quotaError } = await import("./fakes/fake-ai.ts");
    env = await makeEnv({ rules: [{ match: isStage("coo_route"), reply: { error: quotaError(Date.now() + 1000, "instruction") } }] });
    const id = env.api.addInstruction("指示の上限");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    expect(env.api.inst(id).error).toMatch(/^上限: トークン/);
    expect(env.api.releases).toHaveLength(0);
  });

  it("メンバーのターンの上限でタスクが failed、全部失敗なら指示も failed", async () => {
    env = await makeEnv({
      limits: { memberTurns: 2 },
      rules: [
        ...normalRules().filter((r) => ["route", "plan"].includes(r.name ?? "")),
        { match: isStage("member_step"), reply: J({ kind: "tool", tool: "fs_list", args: {}, why: "見るだけ" }), times: 100 },
      ],
    });
    const id = env.api.addInstruction("終わらないメンバー");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    const works = env.api.tasksOf(id).filter((t) => t.kind === "work");
    expect(works.every((t) => t.status === "failed" && t.resultSummary?.startsWith("上限: ターン（2 回）"))).toBe(true);
    expect(env.ai.callsFor("member_step")).toHaveLength(4);
    expect(env.api.inst(id).status).toBe("failed");
  });

  it("経過時間の上限で failed", async () => {
    let clock = 1_000_000;
    env = await makeEnv({
      limits: { instructionWallClockMs: 30 * 60_000 },
      deps: { now: () => clock },
      rules: normalRules().map((r) => ({
        ...r,
        reply: (() => {
          clock += 11 * 60_000; // 1 回の応答で 11 分たつ
          return r.reply as string;
        }) as unknown as string,
      })),
    });
    const id = env.api.addInstruction("遅い");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    expect(env.api.inst(id).error).toBe("上限: 経過時間（30 分）");
    expect(env.ai.calls).toHaveLength(3);
  });
});
