// 台本（シナリオ B・汎用のマーカー）と、道具・ルール・引数の単体。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMemberTaskInput, buildThreadTurnInput, parseTurnOutput, type CooTurn, type LeaderTurn } from "@baton/shared";
import { parseArgs, splitToolList } from "../src/args.ts";
import { evaluatePermission, parseRule, pathPatternMatches, splitCommand } from "../src/rules.ts";
import { resolveConflictText } from "../src/scripts/member.ts";
import { roleArgs } from "./args-for.ts";
import { COMMON_ARGS, cleanEnv, expectValidStream, runOnce, structuredOf, tempDir } from "./helpers.ts";

let tmp: { dir: string; cleanup: () => void };
let env: NodeJS.ProcessEnv;
let n = 0;
beforeAll(() => {
  tmp = tempDir();
  env = cleanEnv(path.join(tmp.dir, "state"));
});
afterAll(() => tmp.cleanup());
function ws(): string {
  const d = path.join(tmp.dir, `ws${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
}
const NOW = Date.parse("2026-10-21T01:12:00Z");
const IID = "9f8e7d6c-0000-4000-8000-00000000000a";

async function oneTurn<R extends "coo" | "leader" | "member">(role: R, cwd: string, input: string, extra: string[] = []) {
  const r = await runOnce(roleArgs(role, { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: [...extra, input] }), { cwd, env });
  expect(r.exit.code, r.proc.stderr).toBe(0);
  const norm = expectValidStream(r.raw, cwd);
  const out = parseTurnOutput(role, structuredOf(r.lines));
  if (!out.ok) throw new Error(out.error);
  const result = norm.sessions.find((s) => s.kind === "result");
  return { value: out.value, reply: result?.kind === "result" ? result.replyText : "", norm, lines: r.lines };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

describe("COO の汎用の台本", () => {
  it("マーカーなし: すぐ delegate（Baton 専用「テスト」、マーカーは brief に残る）", async () => {
    const t = await oneTurn("coo", ws(), "[CEO] 競合の料金を調べて [approve@member]");
    const d = (t.value as CooTurn).actions[0];
    if (d?.type !== "delegate" || d.project.mode !== "new") throw new Error("delegate");
    expect(d.project.name).toBe("テスト");
    expect(d.project.slug).toMatch(/^test-[0-9a-f]{6}$/);
    expect(d.title).toBe("競合の料金を調べて");
    expect(d.brief).toContain("[approve@member]");
  });

  it("[propose][repo]: propose_project（repoPath は FAKE_CLAUDE_REPO_PATH）→ 立った知らせで existing に delegate", async () => {
    const cwd = ws();
    const id = randomUUID();
    const e = { ...env, FAKE_CLAUDE_REPO_PATH: "/Users/test/projects/sample-repo" };
    const r1 = await runOnce(roleArgs("coo", { session: { id, resume: false }, cwd, stream: false, extra: ["[CEO] 既存のリポジトリで直して [propose] [repo]"] }), { cwd, env: e });
    const v1 = parseTurnOutput("coo", structuredOf(r1.lines));
    if (!v1.ok) throw new Error(v1.error);
    expect(v1.value.actions[0]).toMatchObject({ type: "propose_project", workspace: { kind: "repo", repoPath: "/Users/test/projects/sample-repo" } });
    const r2 = await runOnce(roleArgs("coo", { session: { id, resume: true }, cwd, stream: false, extra: ["[知らせ] プロジェクト「テスト」が立ちました（id: proj_abc123）"] }), { cwd, env: e });
    const v2 = parseTurnOutput("coo", structuredOf(r2.lines));
    if (!v2.ok) throw new Error(v2.error);
    expect(v2.value.actions[0]).toMatchObject({ type: "delegate", project: { mode: "existing", projectId: "proj_abc123" } });
  });

  it("[秘書] だけ: 立てない・振らない（B4）", async () => {
    const t = await oneTurn("coo", ws(), "[秘書] 新しいプロジェクトを始めて");
    expect((t.value as CooTurn).actions).toEqual([]);
    expect(t.reply).toContain("CEO に確かめます");
  });

  it("[リーダーの質問] → answer_leader、[CEO の差し戻し] → relay（入力の版）", async () => {
    const input = buildThreadTurnInput({
      threadKind: "coo",
      now: NOW,
      inbox: [
        { kind: "delegation", instructionId: IID, payload: { question: "優先する観点はどれですか？" } },
        { kind: "ceo_message", instructionId: IID, payload: { body: "もう少し短く", sendBack: true } },
      ],
      instructions: [{ id: IID, title: "x", status: "review", phase: null, revision: 3 }],
    });
    const t = await oneTurn("coo", ws(), input);
    const types = (t.value as CooTurn).actions.map((a) => a.type);
    expect(types).toEqual(["answer_leader", "relay"]);
    expect((t.value as CooTurn).actions[1]).toMatchObject({ instructionId: IID, revision: 3, message: "もう少し短く" });
  });

  it("[long]: 道具が並び、長い返事になる", async () => {
    const t = await oneTurn("coo", ws(), "[CEO] たくさん [long]", []);
    // COO の --max-turns 20 を超えない数（20 − 6）
    expect(t.norm.items.filter((i) => i.kind === "tool_use").length).toBe(14);
    expect(t.reply.length).toBeGreaterThan(5000);
  });
});

describe("リーダーの汎用の台本", () => {
  const leaderInput = (body: string) =>
    buildThreadTurnInput({ threadKind: "leader", now: NOW, inbox: [{ kind: "delegation", instructionId: IID, payload: { body } }], instructions: [{ id: IID, title: "x", status: "running", phase: "leader", revision: 1 }] });

  it("依頼で 1 タスク（エンジニア）、マーカーを spec に引き継ぐ", async () => {
    const t = await oneTurn("leader", ws(), leaderInput("料金を調べて [approve] [slow@member]"));
    const plan = (t.value as LeaderTurn).actions[0];
    if (plan?.type !== "plan") throw new Error("plan");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ key: "t1", assignee: "エンジニア" });
    expect(plan.tasks[0]?.spec).toContain("[approve]");
    expect(plan.tasks[0]?.spec).toContain("[slow@member]");
  });

  it("[ask-coo]: まず ask_coo、COO の答えで plan", async () => {
    const cwd = ws();
    const id = randomUUID();
    const r1 = await runOnce(roleArgs("leader", { session: { id, resume: false }, cwd, stream: false, extra: [leaderInput("調べて [ask-coo] [approve]")] }), { cwd, env });
    const v1 = parseTurnOutput("leader", structuredOf(r1.lines));
    expect(v1.ok && v1.value.actions[0]?.type).toBe("ask_coo");
    const r2 = await runOnce(roleArgs("leader", { session: { id, resume: true }, cwd, stream: false, extra: [leaderInput("おまかせします")] }), { cwd, env });
    const v2 = parseTurnOutput("leader", structuredOf(r2.lines));
    expect(v2.ok && v2.value.actions[0]?.type).toBe("plan");
    const plan = v2.ok ? v2.value.actions[0] : undefined;
    expect(plan?.type === "plan" && plan.tasks[0]?.spec).toContain("[approve]");
  });

  it("[メンバーの質問] → answer_member（セッション ID を拾う）", async () => {
    const input = buildThreadTurnInput({
      threadKind: "leader",
      now: NOW,
      inbox: [{ kind: "member_question", instructionId: IID, payload: { sessionId: "sess-123", assignee: "エンジニア", question: "どちら？" } }],
      instructions: [],
    });
    const t = await oneTurn("leader", ws(), input);
    expect((t.value as LeaderTurn).actions[0]).toMatchObject({ type: "answer_member", sessionId: "sess-123" });
  });

  it("[no-report] の CEO の発言は会話の区切りで cooReport", async () => {
    const cwd = ws();
    const id = randomUUID();
    const st = [{ id: IID, title: "x", status: "running", phase: "leader" as const, revision: 1 }];
    const r1 = await runOnce(
      roleArgs("leader", { session: { id, resume: false }, cwd, stream: false, extra: [buildThreadTurnInput({ threadKind: "leader", now: NOW, inbox: [{ kind: "ceo_message", instructionId: null, payload: { body: "見出しを足して [no-report]" } }], instructions: st })] }),
      { cwd, env },
    );
    const v1 = parseTurnOutput("leader", structuredOf(r1.lines));
    expect(v1.ok && v1.value.cooReport).toBeNull();
    const r2 = await runOnce(
      roleArgs("leader", { session: { id, resume: true }, cwd, stream: false, extra: [buildThreadTurnInput({ threadKind: "leader", now: NOW, inbox: [{ kind: "instruction_event", instructionId: null, payload: { type: "conversation_break" } }], instructions: st })] }),
      { cwd, env },
    );
    const v2 = parseTurnOutput("leader", structuredOf(r2.lines));
    expect(v2.ok && v2.value.cooReport).toMatchObject({ change: "none", instructionIds: [IID] });
  });
});

describe("シナリオ B2: paths が重なって衝突 → resolve_conflict → 解決", () => {
  it("2 人が同じファイルを書き、統合で衝突し、解決タスクのメンバーが印を外す", async () => {
    const repo = ws();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const leaderCwd = ws();
    const leaderId = randomUUID();
    const lr = await runOnce(
      roleArgs("leader", {
        session: { id: leaderId, resume: false },
        cwd: leaderCwd,
        stream: false,
        extra: [buildThreadTurnInput({ threadKind: "leader", now: NOW, inbox: [{ kind: "delegation", instructionId: IID, payload: { body: "メモを書いて [conflict]" } }], instructions: [{ id: IID, title: "x", status: "running", phase: "leader", revision: 1 }] })],
      }),
      { cwd: leaderCwd, env },
    );
    const plan = parseTurnOutput("leader", structuredOf(lr.lines));
    if (!plan.ok || plan.value.actions[0]?.type !== "plan") throw new Error("plan");
    const tasks = plan.value.actions[0].tasks;
    expect(tasks.map((t) => t.paths)).toEqual([["shared/notes.md"], ["shared/notes.md"]]);

    for (const t of tasks) {
      const dir = path.join(tmp.dir, `wt-${t.key}`);
      git(repo, "worktree", "add", "-q", "-b", `baton/x/${t.key}-r1`, dir, "main");
      const r = await runOnce(
        roleArgs("member", { session: { id: randomUUID(), resume: false }, cwd: dir, stream: false, extra: [buildMemberTaskInput({ title: t.title, spec: t.spec, paths: t.paths, goal: "g", dependencyResults: [], worktree: dir })] }),
        { cwd: dir, env },
      );
      expect(r.exit.code, r.proc.stderr).toBe(0);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", t.key);
    }
    git(repo, "merge", "-q", "--no-ff", "--no-edit", "baton/x/t1-r1");
    expect(() => git(repo, "merge", "-q", "--no-ff", "--no-edit", "baton/x/t2-r1")).toThrow();
    git(repo, "merge", "--abort");

    // リーダーは [衝突] で resolve_conflict（担当は t2 のライター）
    const lc = await runOnce(
      roleArgs("leader", {
        session: { id: leaderId, resume: true },
        cwd: leaderCwd,
        stream: false,
        extra: [buildThreadTurnInput({ threadKind: "leader", now: NOW, inbox: [{ kind: "merge_conflict", instructionId: IID, payload: { taskKey: "t2", files: ["shared/notes.md"] } }], instructions: [{ id: IID, title: "x", status: "running", phase: "members", revision: 1 }] })],
      }),
      { cwd: leaderCwd, env },
    );
    const rc = parseTurnOutput("leader", structuredOf(lc.lines));
    expect(rc.ok && rc.value.actions[0]).toMatchObject({ type: "resolve_conflict", instructionId: IID, taskKey: "t2", assignee: "ライター" });

    // 解決タスク: 統合用の先頭から切った worktree に merge --no-commit で印を入れて渡す
    const fix = path.join(tmp.dir, "wt-fix");
    git(repo, "worktree", "add", "-q", "-b", "baton/x/t2-fix", fix, "main");
    expect(() => git(fix, "merge", "--no-commit", "--no-ff", "baton/x/t2-r1")).toThrow();
    const r = await runOnce(
      roleArgs("member", { session: { id: randomUUID(), resume: false }, cwd: fix, stream: false, extra: [buildMemberTaskInput({ title: "衝突の解決", spec: "shared/notes.md の衝突を直す", paths: ["shared/notes.md"], goal: "g", dependencyResults: [], worktree: fix })] }),
      { cwd: fix, env },
    );
    expect(r.exit.code, r.proc.stderr).toBe(0);
    const text = readFileSync(path.join(fix, "shared/notes.md"), "utf8");
    expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(text).toContain("A 案");
    expect(text).toContain("B 案");
    const out = parseTurnOutput("member", structuredOf(r.lines));
    expect(out.ok && out.value.kind === "done" && out.value.summary).toContain("衝突を解決しました");
  });
});

describe("道具の結果の形（[tools]）", () => {
  it("Read・Write・Edit・Bash・Glob・Grep・TodoWrite・WebSearch・WebFetch が正規化を通り、要約が日本語の固定動詞になる", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "--include-partial-messages", "--permission-mode", "bypassPermissions", "[tools]"], { cwd, env });
    expect(r.exit.code, r.proc.stderr).toBe(0);
    const norm = expectValidStream(r.raw, cwd);
    const uses = norm.items.filter((i) => i.kind === "tool_use").map((i) => i.summary);
    expect(uses).toEqual(["TODO を更新", "作成した notes.md", "検索した **/*.md", "読んだ notes.md", "検索した greeting", "編集した notes.md", "実行した ls", "調べた コーヒー 産地", "取得した example.com", "TODO を更新"]);
    const results = norm.items.filter((i) => i.kind === "tool_result");
    expect(results.find((i) => i.toolName === "Write")?.summary).toBe("作成した notes.md（+3 −0）");
    expect(results.find((i) => i.toolName === "Edit")?.summary).toBe("編集した notes.md（+1 −1）");
    expect(results.find((i) => i.toolName === "Bash")?.body).toMatchObject({ stdout: "notes.md" });
    expect(results.every((i) => !i.isError)).toBe(true);
    expect(readFileSync(path.join(cwd, "notes.md"), "utf8")).toContain("こんにちは");
    // 道具の前の reset と、最後の文章が返事になる（D-100）
    expect(norm.deltas.some((d) => d.type === "reset")).toBe(true);
    const res = norm.sessions.find((s) => s.kind === "result");
    expect(res?.kind === "result" && res.replyText).toContain("受け取りました");
  });

  it("--tools に無い道具は No such tool available", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "[tools]", "--permission-mode", "bypassPermissions", "--tools", "Read,TodoWrite"], { cwd, env });
    const norm = expectValidStream(r.raw, cwd);
    expect(norm.items.some((i) => i.kind === "tool_result" && i.isError && i.toolName === "Write")).toBe(true);
  });

  it("--output-format json は result だけ、text は本文だけ", async () => {
    const cwd = ws();
    const j = await runOnce(["-p", "--output-format", "json", "こんにちは"], { cwd, env });
    expect(j.lines).toHaveLength(1);
    expect(j.lines[0]?.type).toBe("result");
  });
});

describe("単体: 引数とルール", () => {
  it("variadic のフラグと、括弧の中の空白", () => {
    const a = parseArgs(["-p", "--allowedTools", "Read", "Bash(git log *)", "Edit(//x/**)", "--tools", "Read,Grep", "--setting-sources", "", "--max-turns", "3"]);
    expect(a.allowedTools).toEqual(["Read", "Bash(git log *)", "Edit(//x/**)"]);
    expect(a.tools).toEqual(["Read", "Grep"]);
    expect(a.settingSources).toBe("");
    expect(a.maxTurns).toBe(3);
    expect(splitToolList(["Read, Bash(npm run *)"])).toEqual(["Read", "Bash(npm run *)"]);
    expect(() => parseArgs(["-p", "--output-format", "stream-json", "x"])).toThrow(/--verbose/);
  });

  it("Bash は区切りごと、パスは gitignore 形式", () => {
    expect(splitCommand("cd a && npm test | tee x; echo 'a;b'")).toEqual(["cd a", "npm test", "tee x", "echo 'a;b'"]);
    const ctx = { cwd: "/w", addDirs: [], allow: ["Bash(npm test *)", "Bash(npm test)", "Edit(//w/**)"].map(parseRule), deny: ["Bash(rm *)", "Read(**/.env)"].map(parseRule), mode: "default" };
    expect(evaluatePermission(ctx, "Bash", { command: "npm test" }).kind).toBe("allow");
    expect(evaluatePermission(ctx, "Bash", { command: "npm test && rm -rf /" }).kind).toBe("deny");
    expect(evaluatePermission(ctx, "Bash", { command: "npm test && ls" }).kind).toBe("ask");
    expect(evaluatePermission(ctx, "Write", { file_path: "/w/a/b.md" }).kind).toBe("allow");
    expect(evaluatePermission(ctx, "Write", { file_path: "/x/b.md" }).kind).toBe("ask");
    expect(evaluatePermission(ctx, "Read", { file_path: "/w/.env" }).kind).toBe("deny");
    expect(evaluatePermission(ctx, "Read", { file_path: "/w/a.md" }).kind).toBe("allow");
    expect(evaluatePermission(ctx, "Read", { file_path: "/etc/hosts" }).kind).toBe("ask");
    expect(pathPatternMatches("*.pem", "/a/b/c.pem", "/w")).toBe(true);
    expect(pathPatternMatches("/src/**", "/w/src/a.ts", "/w")).toBe(true);
  });

  it("衝突の印を外して両方を残す", () => {
    expect(resolveConflictText("a\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> t2\nz")).toBe("a\nA\nB\nz");
  });
});
