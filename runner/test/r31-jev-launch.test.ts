// R31 メンバーの起動と再開（5.9.1・D-132〜D-136）: 偽 claude ＋ FakeJev。新しいセッションの起動時だけ Jev に聞き、--resume と引き継ぎは前回と同じ値。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID, type Task } from "@baton/shared";
import { buildArgs } from "../src/claude/args.ts";
import { getProfile } from "../src/claude/profiles.ts";
import { StopSignal } from "../src/errors.ts";
import { silentLogger } from "../src/log.ts";
import { createContext } from "../src/main.ts";
import { memberLaunchFor, modelFor } from "../src/orchestrator/common.ts";
import { FakeJev, makeClaudeSpy, type FakeJevScript } from "./fakes/fake-jev.ts";
import { FAKE_CLAUDE, makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

const FAST: FakeJevScript = { tier: "fast", confidence: 0.9, effort: 0, effortConfidence: 0.9, risky: 0.02 };

/** Jev 付きの環境。エンジニアを haiku まで下げてよいことにして、偽 claude の起動引数を記録する */
async function setup(script: FakeJevScript, envVars: Record<string, string> = {}, fakeEnv: Record<string, string> = {}) {
  const jev = new FakeJev(script);
  const e = await makeEnv({ jev, fakeEnv, env: { BATON_JEV_ROUTING: "on", ...envVars } });
  const spy2 = await makeClaudeSpy(e.dir, FAKE_CLAUDE);
  e.config.claudeBin = spy2.bin;
  await mkdir(path.dirname(e.config.profilesLocalPath), { recursive: true });
  await writeFile(e.config.profilesLocalPath, JSON.stringify({ profiles: { engineer: { jev: { min: "haiku", max: "opus" } } } }));
  env = e;
  return { e, jev, launches: async () => (await spy2.launches()).filter((l) => l.name.startsWith("baton:member:")), all: spy2.launches };
}

const modelLines = (e: Env, sessionId?: string) => e.api.transcript.filter((t) => t.kind === "system" && t.summary.startsWith("モデル") && (!sessionId || t.sessionId === sessionId));
const memberSession = (e: Env) => [...e.api.sessions.values()].find((s) => s.role === "member")!;

describe("R31 新しいセッションの起動", () => {
  it("fast 0.9・effort 0 → --model haiku --effort low。createSession の model・「モデル」の 1 行・手元の launch・state の中身", async () => {
    const { e, jev, launches } = await setup(FAST);
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    const [l] = await launches();
    expect(l).toMatchObject({ model: "haiku", effort: "low", resume: "" });
    const s = memberSession(e);
    expect(s.model).toBe("haiku");
    const lines = modelLines(e, s.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.summary).toBe("モデル haiku・エフォート low（Jev: fast 0.90）");
    expect(lines[0]!.body).toMatchObject({ model: "haiku", effort: "low", baseModel: "sonnet", baseEffort: null, source: "jev", clamped: [], decision: { tier: "fast", confidence: 0.9, risky: 0.02 } });
    expect((await e.ctx.state.session(s.id))?.launch).toMatchObject({ model: "haiku", effort: "low", source: "jev" });
    // Jev に渡した state
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]).toMatchObject({ kind: "baton_member_task", profile: "engineer", workspace: "baton", round: 1, conflictResolution: false });
    expect(JSON.stringify(jev.calls[0])).not.toContain("テストの目的");
    // トランスクリプトの init は選んだモデル
    expect(e.api.transcript.some((t) => t.sessionId === s.id && t.summary === "開始" && String((t.body as { model?: string }).model).includes("haiku"))).toBe(true);
  }, 40_000);

  it("COO・リーダーのターンでは一度も呼ばない。リーダーに BATON_MODEL_LEADER=opus を置くと --model opus（--fallback-model sonnet は modelFor で確かめる）", async () => {
    const { e, jev, all } = await setup(FAST, { BATON_MODEL_LEADER: "opus" });
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    const roles = (await all()).map((l) => l.name.split(":")[1]);
    expect(roles).toEqual(expect.arrayContaining(["coo", "leader", "member"]));
    expect(jev.calls).toHaveLength((await all()).filter((l) => l.name.startsWith("baton:member:")).length);
    const leader = (await all()).find((l) => l.name.startsWith("baton:leader:"))!;
    expect(leader.model).toBe("opus");
    expect(leader.effort).toBe("");
    expect((await all()).find((l) => l.name.startsWith("baton:coo:"))!.effort).toBe("");
    const profiles = await e.ctx.profiles();
    expect(modelFor(e.ctx, "leader", getProfile(profiles, "leader"))).toEqual({ model: "opus", fallback: "sonnet" });
    expect(modelFor(e.ctx, "coo", getProfile(profiles, "coo"))).toEqual({ model: "opus", fallback: "sonnet" });
    expect(modelFor(e.ctx, "member", getProfile(profiles, "engineer")).fallback).toBeNull();
  }, 40_000);

  it("リーダーが sonnet なら --fallback-model は付かない。引数の組み立て（effort は --model の次）", () => {
    const spec = { role: "member" as const, sessionId: "s", resume: false, cwd: "/w", addDirs: [], model: "haiku", effort: "low", fallbackModel: null, maxTurns: 80, maxBudgetUsd: 6, systemPrompt: "p", pluginDir: null, hasSkills: false, settingsPath: "/s.json", oneTimeAllow: [], extraAllow: [], name: "n" };
    const a = buildArgs(spec);
    expect(a.slice(6, 10)).toEqual(["--model", "haiku", "--effort", "low"]);
    expect(buildArgs({ ...spec, effort: null })).not.toContain("--effort");
  });
});

describe("R31 --resume と引き継ぎは前回と同じ（Jev を呼ばない。D-133）", () => {
  it("追加の依頼（--resume）: 同じ --model・--effort、Jev は 1 回のまま、「モデル」の行は増えない", async () => {
    const { e, jev, launches } = await setup(FAST);
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    const s = memberSession(e);
    expect(s.status).toBe("done");
    e.api.addSessionInput(s.id, "見出しを足して");
    jev.script = { tier: "deep", confidence: 0.99, effort: 3, effortConfidence: 0.99 }; // 呼ばれても違う答えになる
    await e.drain();
    const ls = await launches();
    expect(ls).toHaveLength(2);
    expect(ls[1]).toMatchObject({ model: "haiku", effort: "low", resume: s.id });
    expect(jev.calls).toHaveLength(1);
    expect(modelLines(e)).toHaveLength(1);
  }, 40_000);

  it("ask_leader の答えで続く: 1 回の起動のまま、Jev は 1 回", async () => {
    const { e, jev, launches } = await setup(FAST);
    e.api.ceoSays(COO_THREAD_ID, "表を作って [ask]");
    await e.step();
    await e.step();
    const member = e.step();
    await waitFor(() => e.api.inbox.some((i) => i.kind === "member_question"));
    await Promise.all([member, e.step()]);
    expect(memberSession(e).status).toBe("done");
    expect(await launches()).toHaveLength(1);
    expect(jev.calls).toHaveLength(1);
  }, 40_000);

  it("ランナーの再起動（running のまま残った）: 新しいランナーが同じ値で --resume、Jev は呼ばない", async () => {
    const { e, jev, launches } = await setup(FAST, {}, { FAKE_CLAUDE_SLOW_MS: "200" });
    e.api.ceoSays(COO_THREAD_ID, "長い作業 [slow@member]");
    await e.step();
    await e.step();
    const ac = new AbortController();
    const run = e.step(ac.signal);
    await waitFor(() => e.api.transcript.some((t) => t.kind === "tool_use" && e.api.sessions.get(t.sessionId)?.role === "member"));
    ac.abort(new StopSignal("shutdown"));
    await run;
    const sid = memberSession(e).id;
    expect(jev.calls).toHaveLength(1);
    e.ctx = createContext({ config: e.config, log: silentLogger, api: e.api, jev });
    const { prepareDataDir } = await import("../src/startup.ts");
    await prepareDataDir(e.ctx);
    jev.script = { tier: "deep", confidence: 0.99, effort: 3, effortConfidence: 0.99 };
    await e.step();
    expect(e.api.sessions.get(sid)!.status).toBe("done");
    const ls = await launches();
    expect(ls).toHaveLength(2);
    expect(ls[1]).toMatchObject({ model: "haiku", effort: "low", resume: sid });
    expect(jev.calls).toHaveLength(1);
  }, 40_000);

  it("--resume できず新しいセッションで引き継ぐ（triedFresh）: 同じ --model・--effort、Jev は呼ばない、「前回と同じ」の行", async () => {
    const { e, jev, launches } = await setup(FAST, {}, { FAKE_CLAUDE_SLOW_MS: "200" });
    e.api.ceoSays(COO_THREAD_ID, "長い作業 [slow@member]");
    await e.step();
    await e.step();
    const ac = new AbortController();
    const run = e.step(ac.signal);
    await waitFor(() => e.api.transcript.some((t) => t.kind === "tool_use" && e.api.sessions.get(t.sessionId)?.role === "member"));
    ac.abort(new StopSignal("shutdown"));
    await run;
    const sid = memberSession(e).id;
    e.ctx = createContext({ config: e.config, log: silentLogger, api: e.api, jev });
    const { prepareDataDir } = await import("../src/startup.ts");
    await prepareDataDir(e.ctx);
    jev.script = { tier: "deep", confidence: 0.99, effort: 3, effortConfidence: 0.99 };
    const stateDir = process.env.FAKE_CLAUDE_STATE_DIR!;
    for (const f of await readdir(stateDir, { recursive: true })) if (String(f).includes(sid)) await rm(path.join(stateDir, String(f)), { recursive: true, force: true });
    await e.step();
    const fresh = [...e.api.sessions.values()].find((s) => s.role === "member" && s.id !== sid)!;
    expect(fresh.model).toBe("haiku");
    const ls = await launches();
    expect(ls.at(-1)).toMatchObject({ model: "haiku", effort: "low", resume: "", sessionId: fresh.id });
    expect(jev.calls).toHaveLength(1);
    expect(modelLines(e, fresh.id).map((t) => t.summary)).toEqual(["モデル haiku・エフォート low（前回と同じ）"]);
    expect(modelLines(e, fresh.id)[0]!.body).toMatchObject({ source: "resume" });
    expect((await e.ctx.state.session(fresh.id))?.launch).toMatchObject({ model: "haiku", effort: "low" });
  }, 40_000);

  it("quota_wait からの復帰: 同じ値で --resume、Jev は呼ばない", async () => {
    const { e, jev, launches } = await setup(FAST, { BATON_QUOTA_RESUME_MARGIN_MS: "0" }, { FAKE_QUOTA_RESET_SEC: "1" });
    e.api.ceoSays(COO_THREAD_ID, "作業 [quota@member]");
    await e.step();
    await e.step();
    await e.step();
    const s = memberSession(e);
    expect(s.status).toBe("quota_wait");
    await new Promise((r) => setTimeout(r, 2100));
    [...e.api.instructions.values()][0]!.notBefore = null;
    jev.script = { tier: "deep", confidence: 0.99, effort: 3 };
    await e.step();
    expect(e.api.sessions.get(s.id)!.status).toBe("done");
    const ls = await launches();
    expect(ls.at(-1)).toMatchObject({ model: "haiku", effort: "low", resume: s.id });
    expect(jev.calls).toHaveLength(1);
  }, 40_000);

  it("古い手元の状態（launch が無い）の --resume は D1 の model と基準のエフォート", async () => {
    const { e, jev, launches } = await setup(FAST);
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    const s = memberSession(e);
    // launch を消し、D1 の model を sonnet に（古いセッションを想定）
    await e.ctx.state.write("session", s.id, { ...(await e.ctx.state.session(s.id)), launch: undefined });
    s.model = "sonnet";
    e.api.addSessionInput(s.id, "見出しを足して");
    await e.drain();
    expect((await launches()).at(-1)).toMatchObject({ model: "sonnet", effort: "", resume: s.id });
    expect(jev.calls).toHaveLength(1);
  }, 40_000);
});

describe("R31 ラウンド 2・衝突の解決・失敗・切り替え", () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: "t1", instructionId: "i1", parentTaskId: null, assigneeAgentId: null, kind: "work", planKey: "t1", dependsOn: [], title: "追加の調査", spec: "ニッチな題材を調べる", paths: ["research/"],
    status: "pending", resultSummary: null, round: 1, seq: 1, startedAt: null, finishedAt: null, updatedAt: 0, ...over,
  });
  const launchFor = async (e: Env, over: Partial<Task> = {}, extra: { conflict?: boolean; profileId?: string } = {}) => {
    const profileId = extra.profileId ?? "generalist";
    return memberLaunchFor(e.ctx, { profileId, profile: getProfile(await e.ctx.profiles(), profileId), task: task(over), round: over.round ?? 1, conflict: extra.conflict ?? false, workspaceKind: "baton" });
  };

  it("ラウンド 2 のタスクと衝突の解決は呼ばれる（round: 2・conflictResolution: true）。衝突の解決は sonnet 以上", async () => {
    const jev = new FakeJev(FAST);
    env = await makeEnv({ jev, env: { BATON_JEV_ROUTING: "on" } });
    const r2 = await launchFor(env, { round: 2, dependsOn: ["a", "b"] });
    expect(r2).toMatchObject({ model: "haiku", effort: "low", source: "jev" });
    expect(jev.calls[0]).toMatchObject({ round: 2, dependsOn: 2, conflictResolution: false, profile: "generalist" });
    const cf = await launchFor(env, { spec: "衝突の解決: baton/x/t1-r1\n..." }, { conflict: true });
    expect(jev.calls[1]).toMatchObject({ conflictResolution: true });
    expect(cf.model).toBe("sonnet");
    expect((cf.item!.body as { clamped: string[] }).clamped.length).toBeGreaterThan(0);
  });

  it("失敗（timeout / http500 / badjson / throw）と 1.5 秒を超える遅れ → プロファイルのモデルで起動し「Jev に聞けず」", async () => {
    const jev = new FakeJev();
    env = await makeEnv({ jev, env: { BATON_JEV_ROUTING: "on", BATON_JEV_TIMEOUT_MS: "100" } });
    for (const fail of ["timeout", "http500", "badjson", "throw"] as const) {
      jev.script = { fail };
      const r = await launchFor(env);
      expect(r).toMatchObject({ model: "sonnet", effort: null, source: "profile" });
      expect(r.item!.summary).toBe("モデル sonnet（Jev に聞けず）");
    }
    jev.script = { ...FAST, delayMs: 5000 };
    const t0 = Date.now();
    const slow = await launchFor(env);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(slow).toMatchObject({ model: "sonnet", effort: null });
    expect(slow.item!.summary).toBe("モデル sonnet（Jev に聞けず）");
  }, 30_000);

  it("失敗した全体の流れ: --model sonnet・--effort 無しで起動し、「モデル sonnet（Jev に聞けず）」", async () => {
    const { e, launches } = await setup({ fail: "http500" });
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    expect((await launches())[0]).toMatchObject({ model: "sonnet", effort: "" });
    expect(modelLines(e).map((t) => t.summary)).toEqual(["モデル sonnet（Jev に聞けず）"]);
    expect(memberSession(e).model).toBe("sonnet");
  }, 40_000);

  it("off（既定）: 呼ばない・引数は今と同じ（--model sonnet・--effort 無し）・「モデル」の行も出さない", async () => {
    const jev = new FakeJev(FAST);
    const probe = await makeEnv({ jev });
    const spy = await makeClaudeSpy(probe.dir, FAKE_CLAUDE);
    probe.config.claudeBin = spy.bin;
    env = probe;
    expect(env.config.jev.routing).toBe("off");
    env.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await env.drain();
    expect(jev.calls).toHaveLength(0);
    const member = (await spy.launches()).filter((l) => l.name.startsWith("baton:member:"));
    expect(member).toHaveLength(1);
    expect(member[0]).toMatchObject({ model: "sonnet", effort: "" });
    expect(modelLines(env)).toHaveLength(0);
    expect(memberSession(env).model).toBe("sonnet");
  }, 40_000);

  it("shadow: 呼んで記録するが、起動は --model sonnet のまま", async () => {
    const { e, jev, launches } = await setup(FAST, { BATON_JEV_ROUTING: "shadow" });
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    expect(jev.calls).toHaveLength(1);
    expect((await launches())[0]).toMatchObject({ model: "sonnet", effort: "" });
    const lines = modelLines(e);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.summary).toBe("モデル sonnet（Jev 試し運転: haiku/low を選ぶはず）");
    expect(lines[0]!.body).toMatchObject({ source: "shadow", model: "sonnet", decision: { tier: "fast" } });
    expect(memberSession(e).model).toBe("sonnet");
  }, 40_000);

  it("BATON_MODEL_MEMBER=haiku: Jev を呼ばず --model haiku に固定", async () => {
    const { e, jev, launches } = await setup(FAST, { BATON_MODEL_MEMBER: "haiku" });
    e.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await e.drain();
    expect(jev.calls).toHaveLength(0);
    expect((await launches())[0]).toMatchObject({ model: "haiku", effort: "" });
    expect(modelLines(e)[0]!.body).toMatchObject({ source: "fixed" });
  }, 40_000);

  it("プロファイルに jev が無い（coo・leader の設定）は振り分けない", async () => {
    const jev = new FakeJev(FAST);
    env = await makeEnv({ jev, env: { BATON_JEV_ROUTING: "on" } });
    const profiles = await env.ctx.profiles();
    const r = await memberLaunchFor(env.ctx, { profileId: "leader", profile: getProfile(profiles, "leader"), task: task(), round: 1, conflict: false, workspaceKind: "baton" });
    expect(r).toMatchObject({ model: "sonnet", source: "profile" });
    expect(jev.calls).toHaveLength(0);
  });
});
