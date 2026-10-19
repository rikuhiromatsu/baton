// シナリオ A（DESIGN-v2 14.1・15.2）を、ランナーと同じ入力の組み立て（turn-input.ts）で通す。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildMemberTaskInput,
  buildThreadTurnInput,
  parseTurnOutput,
  userInput,
  type CooTurn,
  type InboxEntry,
  type LeaderTurn,
} from "@baton/shared";
import { roleArgs } from "./args-for.ts";
import { FakeProc, cleanEnv, expectValidStream, structuredOf, tempDir } from "./helpers.ts";

const NOW = Date.parse("2026-10-21T01:12:00Z");
const INSTRUCTION = "1a2b3c4d-0000-4000-8000-000000000001";

let tmp: { dir: string; cleanup: () => void };
let env: NodeJS.ProcessEnv;
let cooDir: string;
let leaderDir: string;
beforeAll(() => {
  tmp = tempDir();
  env = cleanEnv(path.join(tmp.dir, "state"));
  cooDir = path.join(tmp.dir, "coo");
  leaderDir = path.join(tmp.dir, "leaders", "shorts");
  mkdirSync(cooDir, { recursive: true });
  mkdirSync(leaderDir, { recursive: true });
});
afterAll(() => tmp.cleanup());

/** 1 ターン（stream-json 入力で 1 通送り、result を待って閉じる） */
async function turn(role: "coo" | "leader", cwd: string, session: { id: string; resume: boolean }, input: string) {
  const p = new FakeProc(roleArgs(role, { session, cwd }), { cwd, env });
  p.send(userInput(input));
  await p.waitResults(1);
  p.close();
  const exit = await p.exited;
  expect(exit.code, p.stderr).toBe(0);
  const norm = expectValidStream(p.raw, cwd);
  const result = norm.sessions.find((s) => s.kind === "result");
  if (!result || result.kind !== "result") throw new Error("result がありません");
  const parsed = parseTurnOutput(role, result.structuredOutput);
  if (!parsed.ok) throw new Error(parsed.error);
  return { value: parsed.value, reply: result.replyText, norm, lines: p.lines };
}

const state = (revision: number, status = "running") => [{ id: INSTRUCTION, title: "コーヒー紹介の台本 10 本", status, phase: "leader" as const, revision }];

describe("シナリオ A", () => {
  const coo = { id: randomUUID(), resume: false };
  const leader = { id: randomUUID(), resume: false };
  let plan: LeaderTurn["actions"][number] | undefined;

  it("A1・A2: COO は 1 つのプロセスで質問を返し、2 通目で delegate する（result のあとも次を待つ）", async () => {
    const p = new FakeProc(roleArgs("coo", { session: coo, cwd: cooDir }), { cwd: cooDir, env });
    p.send({ type: "control_request", request_id: "req_init", request: { subtype: "initialize" } });
    await p.waitFor((l) => l.type === "control_response");
    const a1: InboxEntry = { kind: "ceo_message", instructionId: null, payload: { body: "ショート動画の台本 10 本作りたい [scenario-a]" } };
    p.send(userInput(buildThreadTurnInput({ threadKind: "coo", now: NOW, inbox: [a1], instructions: [] })));
    await p.waitResults(1);
    const a2: InboxEntry = { kind: "ceo_message", instructionId: null, payload: { body: "コーヒー紹介のやつです。題材は提案して。" } };
    p.send(userInput(buildThreadTurnInput({ threadKind: "coo", now: NOW, inbox: [a2], instructions: [] })));
    await p.waitResults(2);
    p.close();
    expect((await p.exited).code).toBe(0);

    const norm = expectValidStream(p.raw, cooDir);
    const results = norm.sessions.filter((s) => s.kind === "result");
    expect(results).toHaveLength(2);
    const [r1, r2] = results;
    if (r1?.kind !== "result" || r2?.kind !== "result") throw new Error("result");
    expect(r1.replyText).toBe("なんの動画ですか？");
    const t1 = parseTurnOutput("coo", r1.structuredOutput);
    expect(t1.ok && t1.value).toMatchObject({ awaitingReply: true, actions: [] });
    expect(r2.replyText).toBe("わかりました、ではチームリーダーに依頼します。");
    const t2 = parseTurnOutput("coo", r2.structuredOutput);
    if (!t2.ok) throw new Error(t2.error);
    const del = t2.value.actions[0];
    expect(del?.type).toBe("delegate");
    if (del?.type !== "delegate" || del.project.mode !== "new") throw new Error("delegate new");
    expect(del.project.slug).toBe("shorts");
    expect(del.project.members.map((m) => [m.name, m.profile])).toEqual([
      ["リサーチ", "researcher"],
      ["ライター", "writer"],
    ]);
    expect(del.brief).toContain("[scenario-a]");
    // ストリーミングの差分が届き、つなぐと返事になる（10 文字ずつ）
    const texts = norm.deltas.filter((d) => d.type === "text").map((d) => (d.type === "text" ? d.text : ""));
    expect(texts.every((t) => t.length <= 10)).toBe(true);
    expect(texts.join("")).toContain("なんの動画ですか？");
    // init はターンごと、セッション ID は同じ
    const inits = norm.sessions.filter((s) => s.kind === "init");
    expect(inits).toHaveLength(2);
    expect(new Set(inits.map((s) => s.sessionId))).toEqual(new Set([coo.id]));
    coo.resume = true;
  });

  it("リーダー: 依頼で plan（t1 リサーチ research/・t2 ライター scripts/）", async () => {
    const t = await turn(
      "leader",
      leaderDir,
      leader,
      buildThreadTurnInput({
        threadKind: "leader",
        now: NOW,
        inbox: [{ kind: "delegation", instructionId: INSTRUCTION, payload: { body: "[scenario-a] コーヒー紹介のショート動画の台本を 10 本。" } }],
        instructions: state(1),
      }),
    );
    leader.resume = true;
    expect(t.reply).toBe("了解です。リサーチと執筆で進めます");
    const v = t.value as LeaderTurn;
    plan = v.actions[0];
    expect(plan).toMatchObject({ type: "plan", instructionId: INSTRUCTION });
    if (plan?.type !== "plan") throw new Error("plan");
    expect(plan.tasks.map((x) => [x.key, x.assignee, x.paths])).toEqual([
      ["t1", "リサーチ", ["research/"]],
      ["t2", "ライター", ["scripts/"]],
    ]);
    expect(v.cooReport).toBeNull();
  });

  it("メンバー: 自分の worktree に本当に書き、TodoWrite → Write → done", async () => {
    if (plan?.type !== "plan") throw new Error("plan");
    for (const task of plan.tasks) {
      const ws = path.join(tmp.dir, "worktrees", task.key);
      mkdirSync(ws, { recursive: true });
      const input = buildMemberTaskInput({ title: task.title, spec: task.spec, paths: task.paths, goal: "コーヒー紹介の台本", dependencyResults: [], worktree: ws });
      const p = new FakeProc(roleArgs("member", { session: { id: randomUUID(), resume: false }, cwd: ws, stream: false, extra: [input] }), { cwd: ws, env });
      p.close();
      expect((await p.exited).code, p.stderr).toBe(0);
      const norm = expectValidStream(p.raw, ws);
      const result = norm.sessions.find((s) => s.kind === "result");
      if (result?.kind !== "result") throw new Error("result");
      const out = parseTurnOutput("member", result.structuredOutput);
      if (!out.ok) throw new Error(out.error);
      expect(out.value.kind).toBe("done");
      const names = norm.items.filter((i) => i.kind === "tool_use").map((i) => i.toolName);
      expect(names).toContain("TodoWrite");
      expect(names).toContain("Write");
      const file = task.key === "t1" ? "research/notes.md" : "scripts/scripts.md";
      expect(existsSync(path.join(ws, file))).toBe(true);
      expect(norm.items.some((i) => i.kind === "tool_result" && i.summary.startsWith(`作成した ${file}`))).toBe(true);
      if (out.value.kind === "done") expect(out.value.artifacts[0]?.path).toBe(file);
    }
    expect(readFileSync(path.join(tmp.dir, "worktrees", "t2", "scripts/scripts.md"), "utf8")).toContain("## 10.");
  });

  it("リーダー: [メンバーの結果] で report、COO: [リーダーの成果報告] で present（入力の版）", async () => {
    const lt = await turn(
      "leader",
      leaderDir,
      leader,
      buildThreadTurnInput({
        threadKind: "leader",
        now: NOW,
        inbox: [
          {
            kind: "member_results",
            instructionId: INSTRUCTION,
            payload: { results: [{ taskKey: "t1", assignee: "リサーチ", outcome: "merged", summary: "題材 10 個" }, { taskKey: "t2", assignee: "ライター", outcome: "merged", summary: "台本 10 本" }] },
          },
        ],
        instructions: state(1),
      }),
    );
    expect(lt.reply).toBe("まとめて COO に報告します");
    const report = (lt.value as LeaderTurn).actions[0];
    expect(report).toMatchObject({ type: "report", instructionId: INSTRUCTION });

    const ct = await turn(
      "coo",
      cooDir,
      coo,
      buildThreadTurnInput({
        threadKind: "coo",
        now: NOW,
        inbox: [{ kind: "work_report", instructionId: INSTRUCTION, payload: { leaderName: "リーダー", summary: report?.type === "report" ? report.summary : "", openIssues: [] } }],
        instructions: [{ ...state(1)[0]!, phase: "coo" }],
      }),
    );
    expect(ct.reply.startsWith("チームリーダーから 10 本の案が上がって来ました。\n1. 産地別")).toBe(true);
    expect((ct.value as CooTurn).actions[0]).toMatchObject({ type: "present", instructionId: INSTRUCTION, revision: 1 });
  });

  it("A5・A6: リーダーは「ニッチ」で plan（t3 リサーチ）＋ cooReport direction、「たすかる！」では何もしない", async () => {
    const a5 = await turn(
      "leader",
      leaderDir,
      leader,
      buildThreadTurnInput({
        threadKind: "leader",
        now: NOW,
        inbox: [{ kind: "ceo_message", instructionId: null, payload: { body: "方向性がちょっと違うかも。もっとニッチなやつがいい" } }],
        instructions: state(1, "review"),
      }),
    );
    expect(a5.reply).toBe("わかりました。リサーチメンバーに参考を集めさせます");
    const v = a5.value as LeaderTurn;
    expect(v.actions[0]).toMatchObject({ type: "plan", instructionId: INSTRUCTION, tasks: [{ key: "t3", assignee: "リサーチ" }] });
    expect(v.cooReport).toMatchObject({ change: "direction", instructionIds: [INSTRUCTION] });

    const a6 = await turn(
      "leader",
      leaderDir,
      leader,
      buildThreadTurnInput({
        threadKind: "leader",
        now: NOW,
        inbox: [{ kind: "ceo_message", instructionId: null, payload: { body: "たすかる！" } }],
        instructions: state(2),
      }),
    );
    expect(a6.reply).toBe("");
    expect(a6.value).toEqual({ reply: null, awaitingReply: false, actions: [], cooReport: null });
    expect(a6.norm.items.filter((i) => i.kind === "text")).toHaveLength(0);
  });

  it("A8: COO は報告 2 つ（leader_report と work_report）でニッチ寄りの present", async () => {
    const ct = await turn(
      "coo",
      cooDir,
      coo,
      buildThreadTurnInput({
        threadKind: "coo",
        now: NOW,
        inbox: [
          { kind: "leader_report", instructionId: INSTRUCTION, payload: { leaderName: "リーダー", summary: "CEO と直接話し、題材をニッチ寄りに変更。", change: "direction" } },
          { kind: "work_report", instructionId: INSTRUCTION, payload: { leaderName: "リーダー", summary: "ニッチ寄りに組み直した 10 本の案です。", openIssues: [] } },
        ],
        instructions: [{ ...state(2)[0]!, phase: "coo" }],
      }),
    );
    expect(ct.reply.startsWith("ニッチ寄りに組み直した 10 本です。\n1. ")).toBe(true);
    expect((ct.value as CooTurn).actions[0]).toMatchObject({ type: "present", instructionId: INSTRUCTION, revision: 2 });
  });

  it("COO の相づちには何も書かない", async () => {
    const ct = await turn("coo", cooDir, coo, buildThreadTurnInput({ threadKind: "coo", now: NOW, inbox: [{ kind: "ceo_message", instructionId: null, payload: { body: "ありがとう！" } }], instructions: [] }));
    expect(ct.reply).toBe("");
    expect(ct.value).toEqual({ reply: null, awaitingReply: false, actions: [] });
  });
});
