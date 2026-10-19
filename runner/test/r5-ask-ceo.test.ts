// R5 ask_ceo で decisions が作られ処理が終わる。回答後の再 claim で続きから（plan をやり直さない）。
import { afterEach, describe, expect, it } from "vitest";
import { askCeo, firstUser, isStage, lastUser, normalRules, reviewReport, stageOf, taskKeyOf, J } from "./fakes/fake-ai.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(() => env?.cleanup());

const hasAnswer = (i: Parameters<typeof firstUser>[0]) => /^CEO_ANSWER: /m.test(firstUser(i));

describe("R5 CEO の判断待ち", () => {
  it("COO の ask_ceo で判断を作って終わり、回答後は CEO_ANSWER 付きで振り分けからやり直す", async () => {
    env = await makeEnv({
      rules: [{ match: isStage("coo_route", (i) => !hasAnswer(i)), reply: askCeo("A と B どちら？") }, ...normalRules()],
    });
    const id = env.api.addInstruction("[ask] どっちか決めて");
    const r1 = await env.claimAndRun();
    expect(r1.outcome).toBe("needs_decision");
    const inst = env.api.inst(id);
    expect(inst.status).toBe("needs_decision");
    expect(inst.leaseRunnerId).toBeNull();
    expect(env.api.decisions).toHaveLength(1);
    const d = env.api.decisions[0]!;
    expect(d).toMatchObject({ question: "A と B どちら？", options: ["A案", "B案"], askedByAgentId: "agent-coo", taskId: null, status: "open" });
    expect(env.api.tasksOf(id)).toHaveLength(0);
    // 判断を作ったあとは何も呼ばない
    const afterDecision = env.api.calls.findIndex((c) => c.method === "createDecision");
    expect(env.api.calls.slice(afterDecision + 1).filter((c) => c.instructionId === id)).toHaveLength(0);
    expect(env.api.eventsOf(id).some((e) => e.kind === "decision")).toBe(true);

    // 回答 → queued → 再 claim で続き
    env.api.answerDecision(d.id, "A案");
    const r2 = await env.claimAndRun();
    expect(r2.outcome).toBe("review");
    const routes = env.ai.callsFor("coo_route");
    expect(routes).toHaveLength(2);
    expect(firstUser(routes[1]!)).toMatch(/^CEO_ANSWER: A案$/m);
    // イベントの seq は前回の続きから（重複も欠番もない）
    const seqs = env.api.eventsOf(id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it("まとめ段階の ask_ceo → 回答後は plan も work もやり直さず、まとめから続ける", async () => {
    env = await makeEnv({
      rules: [{ match: isStage("leader_review", (i) => !hasAnswer(i)), reply: askCeo("どちらで報告？") }, ...normalRules()],
    });
    const id = env.api.addInstruction("まとめで迷う");
    expect((await env.claimAndRun()).outcome).toBe("needs_decision");
    const d = env.api.decisions[0]!;
    const review = env.api.tasksOf(id).find((t) => t.kind === "review")!;
    expect(d.taskId).toBe(review.id);
    expect(review.status).toBe("running");
    const callsBefore = env.ai.calls.map(stageOf);

    env.api.answerDecision(d.id, "B案で");
    expect((await env.claimAndRun()).outcome).toBe("review");
    const after = env.ai.calls.slice(callsBefore.length).map(stageOf);
    expect(after).toEqual(["leader_review", "coo_final"]);
    expect(env.ai.callsFor("leader_plan")).toHaveLength(1);
    expect(firstUser(env.ai.callsFor("leader_review")[1]!)).toMatch(/^CEO_ANSWER: B案で$/m);
    expect(env.api.tasksOf(id).filter((t) => t.kind === "plan")).toHaveLength(1);
    expect(env.api.tasksOf(id).filter((t) => t.kind === "work")).toHaveLength(2);
  });

  it("メンバーの ask_ceo では他のメンバーを止めてから判断を作り、回答後はそのタスクから続ける", async () => {
    env = await makeEnv({
      rules: [
        { match: isStage("member_step", (i) => taskKeyOf(i) === "t1" && !hasAnswer(i)), reply: askCeo("どの形式？") },
        { match: isStage("member_step", (i) => taskKeyOf(i) === "t2" && !hasAnswer(i)), reply: J({ kind: "tool", tool: "fs_list", args: {}, why: "見る" }), delayMs: 30, times: 5 },
        ...normalRules(),
      ],
    });
    const id = env.api.addInstruction("形式で迷う");
    expect((await env.claimAndRun()).outcome).toBe("needs_decision");
    const d = env.api.decisions[0]!;
    const t1 = env.api.tasksOf(id).find((t) => t.planKey === "t1")!;
    expect(d.taskId).toBe(t1.id);
    expect(env.api.inst(id).status).toBe("needs_decision");

    env.api.answerDecision(d.id, "Markdown");
    expect((await env.claimAndRun()).outcome).toBe("review");
    expect(env.ai.callsFor("leader_plan")).toHaveLength(1);
    expect(env.api.tasksOf(id).filter((t) => t.kind === "work").every((t) => t.status === "done")).toBe(true);
  });

  it("判断が 3 回に達していたら、ask_ceo を作らずに仮定を置いて進めさせる", async () => {
    env = await makeEnv({
      rules: [
        { match: isStage("coo_route", (i) => !lastUser(i).includes("CEO への確認はこの指示ではもう使えません")), reply: askCeo("また質問") },
        ...normalRules(),
      ],
    });
    const id = env.api.addInstruction("質問の多い指示");
    for (let n = 0; n < 3; n++) {
      env.api.decisions.push({ id: `d${n}`, instructionId: id, taskId: null, askedByAgentId: "agent-coo", question: `q${n}`, options: [], status: "answered", answer: `a${n}`, answeredAt: 1, createdAt: n });
    }
    expect((await env.claimAndRun()).outcome).toBe("review");
    expect(env.api.decisions.filter((d) => d.status === "open")).toHaveLength(0);
    const routes = env.ai.callsFor("coo_route");
    expect(routes).toHaveLength(2);
    expect(lastUser(routes[1]!)).toMatch(/仮定/);
    expect(firstUser(routes[0]!)).toMatch(/^CEO_ANSWER: a2$/m);
    expect(routes[0]!.messages[0]!.content).toContain("あと 0 回");
    // 4 回目の判断は API に送らない（Worker は 400 で拒否するため）
    expect(env.api.calls.some((c) => c.method === "createDecision")).toBe(false);
  });

  it("まとめの report は回答後に使われる（台本の確認）", () => {
    expect(JSON.parse(reviewReport).kind).toBe("report");
  });
});
