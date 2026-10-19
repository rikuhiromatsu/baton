// R7 上限（5.8）: 1 指示の推定額・経過時間で failed「上限に達しました」、承認の回数、ターンの失敗は 1 回だけやり直す。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R7 上限", () => {
  it("1 指示の推定額の上限を超えたら failed（上限に達しました）", async () => {
    env = await makeEnv({ env: { BATON_LIMIT_INSTRUCTION_COST_USD: "0" } });
    env.api.ceoSays(COO_THREAD_ID, "何か作って");
    await env.drain();
    const i = [...env.api.instructions.values()][0]!;
    expect(i.status).toBe("failed");
    expect(i.error).toMatch(/^上限に達しました/);
  }, 30_000);

  it("経過時間（180 分）を超えたら failed", async () => {
    env = await makeEnv({ env: { BATON_LIMIT_INSTRUCTION_WALL_CLOCK_MS: "0" } });
    env.api.ceoSays(COO_THREAD_ID, "何か作って");
    await env.drain();
    expect([...env.api.instructions.values()][0]!.error).toMatch(/経過時間/);
  }, 30_000);

  it("承認の回数の上限を超えたら聞かずに拒否", async () => {
    env = await makeEnv({ env: { BATON_LIMIT_APPROVALS_PER_INSTRUCTION: "0" } });
    env.api.ceoSays(COO_THREAD_ID, "承認の確認 [approve]");
    await env.drain();
    expect(env.api.decisions.size).toBe(0);
    expect([...env.api.tasks.values()][0]!.resultSummary).toContain("承認されなかった");
  }, 30_000);

  it("スキーマ違反は 1 回だけやり直して直れば続く（[badjson-once]）", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] [badjson-once@coo] ショート動画の台本 10 本作りたい");
    await env.step();
    expect(env.api.agentMessages(COO_THREAD_ID).map((m) => m.body)).toEqual(["なんの動画ですか？"]);
    expect(env.api.transcript.some((t) => t.kind === "user" && String((t.body as { text?: string }).text).includes("直前の出力がスキーマに合わなかった"))).toBe(true);
  }, 30_000);

  it("2 回目も失敗（error_max_turns）なら notice「うまく返事ができませんでした」、受信箱は消化済み", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "[maxturns@coo] こんにちは");
    const r = await env.step();
    expect(r?.outcome).toBe("failed");
    const notice = env.api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "notice")!;
    expect(notice.body).toBe("うまく返事ができませんでした");
    expect(env.api.pendingInbox(COO_THREAD_ID)).toHaveLength(0);
    expect(env.api.messagesOf(COO_THREAD_ID).some((m) => m.status === "streaming")).toBe(false);
  }, 30_000);

  it("--max-turns と --max-budget-usd を役割ごとに渡す（BATON_MAX_* で上書き）", async () => {
    env = await makeEnv({ env: { BATON_MAX_TURNS_COO: "7", BATON_MAX_BUDGET_MEMBER: "0.5" } });
    expect(env.config.limits.maxTurns).toEqual({ coo: 7, leader: 30, member: 80 });
    expect(env.config.limits.maxBudgetUsd).toEqual({ coo: 1.5, leader: 2, member: 0.5 });
  });
});
