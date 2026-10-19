// R8 JSON 検査失敗 → 再依頼 → 成功、2 回失敗で退避先。あわせて AI の 503 の再試行と退避先。
import { afterEach, describe, expect, it } from "vitest";
import { isStage, lastUser, normalRules, routeNew, unavailableError } from "./fakes/fake-ai.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(() => env?.cleanup());

const rest = () => normalRules().filter((r) => r.name !== "route");

describe("R8 JSON の検査失敗", () => {
  it("1 回失敗 → JSON_ERROR を付けて同じモデルに再依頼 → 成功", async () => {
    env = await makeEnv({ rules: [{ match: isStage("coo_route"), reply: "了解しました！ {\"kind\": \"route\"" }, { match: isStage("coo_route"), reply: routeNew() }, ...rest()] });
    const id = env.api.addInstruction("[badjson]");
    expect((await env.claimAndRun()).outcome).toBe("review");
    const routes = env.ai.callsFor("coo_route");
    expect(routes).toHaveLength(2);
    expect(lastUser(routes[1]!)).toMatch(/^JSON_ERROR: /);
    expect(routes[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: expect.stringContaining("了解しました") });
    expect(routes[1]!.preferFallback).toBeUndefined();
    expect(env.api.eventsOf(id).some((e) => e.kind === "error" && JSON.stringify(e.content).includes("JSON の検査に失敗"))).toBe(true);
  });

  it("スキーマ違反（kind が無い・長さ超過）も直させる。前後の文章やコードブロックは許す", async () => {
    env = await makeEnv({
      rules: [
        { match: isStage("coo_route"), reply: JSON.stringify({ kind: "route", title: "x".repeat(61), project: { mode: "existing", projectId: "a" }, brief: "b" }) },
        { match: isStage("coo_route"), reply: "```json\n" + routeNew() + "\n```\n以上です" },
        ...rest(),
      ],
    });
    env.api.addInstruction("スキーマ違反");
    expect((await env.claimAndRun()).outcome).toBe("review");
    expect(lastUser(env.ai.callsFor("coo_route")[1]!)).toMatch(/^JSON_ERROR: title/);
  });

  it("2 回失敗 → 退避先（preferFallback）で 1 回 → 成功", async () => {
    env = await makeEnv({
      rules: [
        { match: isStage("coo_route"), reply: "not json", times: 2 },
        { match: isStage("coo_route", (i) => i.preferFallback === true), reply: routeNew() },
        ...rest(),
      ],
    });
    expect((env.api.addInstruction("x"), (await env.claimAndRun()).outcome)).toBe("review");
    const routes = env.ai.callsFor("coo_route");
    expect(routes.map((r) => !!r.preferFallback)).toEqual([false, false, true]);
    expect(lastUser(routes[2]!)).toMatch(/^JSON_ERROR: /);
  });

  it("3 回とも失敗したら段階の失敗。COO の段階なら指示を failed", async () => {
    env = await makeEnv({ rules: [{ match: isStage("coo_route"), reply: "no", times: 3 }] });
    const id = env.api.addInstruction("x");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    expect(env.api.inst(id).error).toMatch(/形式に合いませんでした（coo_route）/);
  });

  it("メンバーの段階の失敗はそのタスクだけ failed にして続ける", async () => {
    env = await makeEnv({
      rules: [{ match: isStage("member_step", (i) => /^TASK_KEY: t2$/m.test(i.messages[1]!.content)), reply: "壊れた", times: 3 }, ...normalRules()],
    });
    const id = env.api.addInstruction("x");
    expect((await env.claimAndRun()).outcome).toBe("review");
    const t2 = env.api.tasksOf(id).find((t) => t.planKey === "t2")!;
    expect(t2.status).toBe("failed");
    expect(t2.resultSummary).toMatch(/形式に合いませんでした/);
  });
});

describe("R8 AI の 503・タイムアウト", () => {
  it("503 は 2 回まで再試行し、それでもだめなら退避先で 1 回", async () => {
    env = await makeEnv({
      rules: [
        { match: isStage("coo_route", (i) => !i.preferFallback), reply: { error: unavailableError() }, times: 3 },
        { match: isStage("coo_route", (i) => i.preferFallback === true), reply: routeNew() },
        ...rest(),
      ],
    });
    const id = env.api.addInstruction("x");
    expect((await env.claimAndRun()).outcome).toBe("review");
    expect(env.ai.callsFor("coo_route").map((r) => !!r.preferFallback)).toEqual([false, false, false, true]);
    expect(env.deps.stats.lastAiError?.instructionId).toBe(id);
  });

  it("退避先もだめなら段階の失敗（指示は failed）", async () => {
    env = await makeEnv({ rules: [{ match: isStage("coo_route"), reply: { error: unavailableError() }, times: 4 }] });
    const id = env.api.addInstruction("x");
    expect((await env.claimAndRun()).outcome).toBe("failed");
    expect(env.api.inst(id).error).toMatch(/AI を呼び出せませんでした/);
  });
});
