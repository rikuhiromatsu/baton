// 制御プロトコル・セッション・エラー・枠（DESIGN-v2 1.2・1.4・5.7・7.6・7.7・9 章）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMemberTaskInput, parseTurnOutput, permissionResponse, userInput } from "@baton/shared";
import { roleArgs } from "./args-for.ts";
import { COMMON_ARGS, FakeProc, cleanEnv, expectValidStream, runOnce, structuredOf, tempDir } from "./helpers.ts";

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

function memberInput(cwd: string, spec: string, paths: string[] = []): string {
  return buildMemberTaskInput({ title: "テストの作業", spec, paths, goal: "テスト", dependencyResults: [], worktree: cwd });
}

/** メンバーを stream-json 入力で起動して 1 通送る */
function startMember(cwd: string, input: string, session = { id: randomUUID(), resume: false }, e = env) {
  const p = new FakeProc(roleArgs("member", { session, cwd }), { cwd, env: e });
  p.send(userInput(input));
  return { p, session };
}

describe("起動まわり", () => {
  it("--version と auth status", async () => {
    const cwd = ws();
    const v = new FakeProc(["--version"], { cwd, env });
    v.close();
    expect((await v.exited).code).toBe(0);
    expect(v.raw[0]).toBe("2.1.303 (Claude Code)");
    const a = new FakeProc(["auth", "status"], { cwd, env });
    a.close();
    expect((await a.exited).code).toBe(0);
    const b = new FakeProc(["auth", "status"], { cwd, env: { ...env, FAKE_CLAUDE_AUTH: "none" } });
    b.close();
    expect((await b.exited).code).toBe(1);
  });

  it("ANTHROPIC_API_KEY が環境にあれば異常終了する（7.7）", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "hi"], { cwd, env: { ...env, ANTHROPIC_API_KEY: "sk-test" } });
    expect(r.exit.code).toBe(3);
    expect(r.proc.stderr).toContain("ANTHROPIC_API_KEY");
    expect(r.raw).toHaveLength(0);
  });

  it("--session-id の重複・無い ID の --resume はエラー、--resume は同じ ID で続く", async () => {
    const cwd = ws();
    const id = randomUUID();
    const first = await runOnce([...COMMON_ARGS, "--session-id", id, "こんにちは"], { cwd, env });
    expect(first.exit.code).toBe(0);
    expectValidStream(first.raw, cwd);
    const dup = await runOnce([...COMMON_ARGS, "--session-id", id, "again"], { cwd, env });
    expect(dup.exit.code).toBe(1);
    expect(dup.proc.stderr).toContain("already in use");
    const missing = await runOnce([...COMMON_ARGS, "--resume", randomUUID(), "x"], { cwd, env });
    expect(missing.exit.code).toBe(1);
    expect(missing.proc.stderr).toContain("No conversation found");
    const resumed = await runOnce([...COMMON_ARGS, "--resume", id, "続き"], { cwd, env });
    expect(resumed.exit.code).toBe(0);
    const norm = expectValidStream(resumed.raw, cwd);
    expect(norm.sessions.map((s) => s.sessionId)).toEqual([id, id]);
  });

  it("init: --plugin-dir のスキル、--strict-mcp-config、[apikey]・[mcpleak]", async () => {
    const cwd = ws();
    const plugin = path.join(cwd, "plugin");
    mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(plugin, "skills", "sns-url-research"), { recursive: true });
    writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "baton-researcher" }));
    writeFileSync(path.join(plugin, "skills", "sns-url-research", "SKILL.md"), "---\nname: sns-url-research\n---\n");
    const ok = await runOnce([...COMMON_ARGS, "--plugin-dir", plugin, "hi"], { cwd, env });
    const init = expectValidStream(ok.raw, cwd).sessions[0];
    if (init?.kind !== "init") throw new Error("init");
    expect(init.skills).toContain("baton-researcher:sns-url-research");
    expect(init.plugins).toContain("baton-researcher");
    expect(init.mcpServers).toEqual([]);
    expect(init.apiKeySource).toBe("none");

    const noStrict = await runOnce(["-p", "--output-format", "stream-json", "--verbose", "hi"], { cwd, env });
    const i2 = expectValidStream(noStrict.raw, cwd).sessions[0];
    expect(i2?.kind === "init" && i2.mcpServers.length).toBeGreaterThan(0);

    const leak = await runOnce([...COMMON_ARGS, "[apikey] [mcpleak]"], { cwd, env });
    const i3 = expectValidStream(leak.raw, cwd).sessions[0];
    if (i3?.kind !== "init") throw new Error("init");
    expect(i3.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(i3.mcpServers.length).toBe(1);
  });

  it("--permission-mode manual は init で default と出る（D-99）", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "--permission-mode", "manual", "hi"], { cwd, env });
    const init = expectValidStream(r.raw, cwd).sessions[0];
    expect(init?.kind === "init" && init.permissionMode).toBe("default");
  });

  it("SIGTERM で 143、そのターンはセッションに記録されない", async () => {
    const cwd = ws();
    const id = randomUUID();
    const p = new FakeProc([...COMMON_ARGS, "--input-format", "stream-json", "--session-id", id], { cwd, env: { ...env, FAKE_CLAUDE_STEP_MS: "500" } });
    p.send(userInput("[slow] ゆっくり"));
    await p.waitFor((l) => l.type === "system");
    p.child.kill("SIGTERM");
    const exit = await p.exited;
    expect(exit.code).toBe(143);
  });
});

describe("承認（--permission-prompt-tool stdio。7.6）", () => {
  it("[approve]: 許可リスト外の Bash で can_use_tool → allow で実行され、ファイルが書かれる", async () => {
    const cwd = ws();
    const { p } = startMember(cwd, memberInput(cwd, "承認の確認 [approve]"));
    const req = await p.waitFor((l) => l.type === "control_request");
    const r = req.request as { subtype: string; tool_name: string; input: Record<string, unknown> };
    expect(r.subtype).toBe("can_use_tool");
    expect(r.tool_name).toBe("Bash");
    expect(r.input.command).toBe("echo ok > approved.txt");
    p.send(permissionResponse(String(req.request_id), { behavior: "allow", updatedInput: r.input }));
    await p.waitResults(1);
    p.close();
    expect((await p.exited).code).toBe(0);
    expect(existsSync(path.join(cwd, "approved.txt"))).toBe(true);
    const norm = expectValidStream(p.raw, cwd);
    expect(norm.controls.some((c) => c.kind === "can_use_tool")).toBe(true);
    const out = parseTurnOutput("member", structuredOf(p.lines));
    expect(out.ok && out.value.kind).toBe("done");
  });

  it("[approve] を拒否すると tool_result がエラーになり、permission_denials に残り、続けて done", async () => {
    const cwd = ws();
    const { p } = startMember(cwd, memberInput(cwd, "承認の確認 [approve]"));
    const req = await p.waitFor((l) => l.type === "control_request");
    p.send(permissionResponse(String(req.request_id), { behavior: "deny", message: "CEO が拒否しました" }));
    const result = await p.waitResults(1);
    p.close();
    await p.exited;
    expect(existsSync(path.join(cwd, "approved.txt"))).toBe(false);
    expect(result.permission_denials).toHaveLength(1);
    const norm = expectValidStream(p.raw, cwd);
    expect(norm.items.some((i) => i.kind === "tool_result" && i.isError && i.summary.includes("CEO が拒否しました"))).toBe(true);
    const out = parseTurnOutput("member", structuredOf(p.lines));
    expect(out.ok && out.value.kind === "done" && out.value.summary).toContain("承認されなかった");
  });

  it("[deny]: worktree の外への Write は can_use_tool で聞かれる（ランナーの方針で拒否する対象）", async () => {
    const cwd = ws();
    const { p } = startMember(cwd, memberInput(cwd, "外に書く [deny]"));
    const req = await p.waitFor((l) => l.type === "control_request");
    const r = req.request as { tool_name: string; input: { file_path: string } };
    expect(r.tool_name).toBe("Write");
    expect(r.input.file_path.startsWith(`${cwd}/`)).toBe(false);
    p.send(permissionResponse(String(req.request_id), { behavior: "deny", message: "作業フォルダの外には書けません" }));
    await p.waitResults(1);
    p.close();
    await p.exited;
    expect(existsSync(r.input.file_path)).toBe(false);
    expectValidStream(p.raw, cwd);
  });

  it("dontAsk（stdio なし）では聞かずに拒否し、system/permission_denied を出す", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "[approve]", "--permission-mode", "dontAsk", "--allowedTools", "Read"], { cwd, env });
    const norm = expectValidStream(r.raw, cwd);
    expect(norm.items.some((i) => i.kind === "denied" && i.toolName === "Bash")).toBe(true);
    expect(r.lines.some((l) => l.type === "control_request")).toBe(false);
  });

  it("--disallowedTools の前方一致は許可より先に効く", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "[approve]", "--permission-mode", "dontAsk", "--allowedTools", "Bash(echo *)", "--disallowedTools", "Bash(echo ok *)"], { cwd, env });
    const norm = expectValidStream(r.raw, cwd);
    expect(norm.items.some((i) => i.kind === "denied")).toBe(true);
    expect(existsSync(path.join(cwd, "approved.txt"))).toBe(false);
  });

  it("1 回限りの許可ルール（Bash(<全文>)）があれば聞かずに実行する（承認の時間切れのあとの --resume）", async () => {
    const cwd = ws();
    const session = { id: randomUUID(), resume: false };
    const first = new FakeProc(roleArgs("member", { session, cwd }), { cwd, env });
    first.send(userInput(memberInput(cwd, "承認の確認 [approve]")));
    const req = await first.waitFor((l) => l.type === "control_request");
    // 時間切れ: deny → interrupt → 閉じる
    first.send(permissionResponse(String(req.request_id), { behavior: "deny", message: "時間切れ", interrupt: true }));
    await first.waitResults(1);
    first.close();
    expect((await first.exited).code).toBe(1);
    expect(first.lines.some((l) => l.type === "user" && JSON.stringify(l).includes("[Request interrupted by user]"))).toBe(true);

    const second = new FakeProc(roleArgs("member", { session: { id: session.id, resume: true }, cwd, extra: ["--allowedTools", "Bash(echo ok > approved.txt)"] }), { cwd, env });
    second.send(userInput("[ランナー] CEO が許可した。続けて"));
    await second.waitResults(1);
    second.close();
    expect((await second.exited).code).toBe(0);
    expect(second.lines.some((l) => l.type === "control_request")).toBe(false);
    expect(existsSync(path.join(cwd, "approved.txt"))).toBe(true);
    const out = parseTurnOutput("member", structuredOf(second.lines));
    expect(out.ok && out.value.kind).toBe("done");
  });
});

describe("中断・追加の入力（5.7）", () => {
  it("interrupt: control_response（still_queued）→ [Request interrupted by user] → result（aborted_streaming）。次の入力も受ける", async () => {
    const cwd = ws();
    const p = new FakeProc(roleArgs("coo", { session: { id: randomUUID(), resume: false }, cwd }), { cwd, env: { ...env, FAKE_CLAUDE_SLOW_MS: "50", FAKE_CLAUDE_SLOW_DELTA_MS: "100" } });
    p.send(userInput("[CEO] 長めに考えて [slow]"));
    await p.waitFor((l) => l.type === "stream_event" && (l.event as { delta?: { type?: string } }).delta?.type === "text_delta");
    p.send({ type: "control_request", request_id: "req_int", request: { subtype: "interrupt" } });
    const r1 = await p.waitResults(1);
    expect(r1).toMatchObject({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" });
    const ack = p.lines.find((l) => l.type === "control_response") as { response: { request_id: string; response: unknown } } | undefined;
    expect(ack?.response).toMatchObject({ request_id: "req_int", response: { still_queued: [] } });
    p.send(userInput("[CEO] たすかる"));
    const r2 = await p.waitResults(2);
    expect(r2.subtype).toBe("success");
    p.close();
    expect((await p.exited).code).toBe(0);
    const norm = expectValidStream(p.raw, cwd);
    expect(norm.items.some((i) => i.kind === "system" && i.summary === "中断")).toBe(true);
  });

  it("動いているターンに user が来たら「追加の依頼を受けました: …」", async () => {
    const cwd = ws();
    const p = new FakeProc([...COMMON_ARGS, "--input-format", "stream-json"], { cwd, env: { ...env, FAKE_CLAUDE_SLOW_MS: "300" } });
    p.send(userInput("[slow] [tools] ゆっくり"));
    await p.waitFor((l) => l.type === "assistant");
    p.send(userInput("[CEO の追加の依頼] 表にもして"));
    await p.waitResults(1);
    p.close();
    await p.exited;
    const norm = expectValidStream(p.raw, cwd);
    expect(norm.items.some((i) => i.kind === "text" && i.summary === "追加の依頼を受けました: 表にもして")).toBe(true);
    expect(p.lines.filter((l) => l.type === "result")).toHaveLength(1);
  });
});

describe("エラーと失敗のマーカー", () => {
  it("[maxturns]: 道具 1 回で error_max_turns、終了コード 1", async () => {
    const cwd = ws();
    const r = await runOnce(roleArgs("member", { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: [memberInput(cwd, "x [maxturns]")] }), { cwd, env });
    expect(r.exit.code).toBe(1);
    const res = r.lines.find((l) => l.type === "result");
    expect(res).toMatchObject({ subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", num_turns: 2 });
    expectValidStream(r.raw, cwd);
  });

  it("--max-turns も効く", async () => {
    const cwd = ws();
    const r = await runOnce([...COMMON_ARGS, "--max-turns", "2", "[tools]"], { cwd, env });
    expect(r.lines.find((l) => l.type === "result")).toMatchObject({ subtype: "error_max_turns", num_turns: 3 });
  });

  it("[fail] は error_during_execution（api_retry つき）", async () => {
    const cwd = ws();
    const r = await runOnce(roleArgs("coo", { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: ["[CEO] x [fail]"] }), { cwd, env });
    expect(r.exit.code).toBe(1);
    expect(r.lines.find((l) => l.type === "result")).toMatchObject({ subtype: "error_during_execution", is_error: true });
    const norm = expectValidStream(r.raw, cwd);
    expect(norm.items.some((i) => i.summary === "再試行")).toBe(true);
  });

  it("[fail@member] は COO では効かない", async () => {
    const cwd = ws();
    const r = await runOnce(roleArgs("coo", { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: ["[CEO] x [fail@member]"] }), { cwd, env });
    expect(r.exit.code).toBe(0);
    const out = parseTurnOutput("coo", structuredOf(r.lines));
    if (!out.ok) throw new Error(out.error);
    const d = out.value.actions[0];
    expect(d?.type === "delegate" && d.brief).toContain("[fail@member]");
  });

  it("[badjson] はスキーマに合わない値、[badjson-once] は同じ入力の 2 回目で直る", async () => {
    const cwd = ws();
    const bad = await runOnce(roleArgs("coo", { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: ["[CEO] x [badjson]"] }), { cwd, env });
    expect(parseTurnOutput("coo", structuredOf(bad.lines)).ok).toBe(false);
    expectValidStream(bad.raw, cwd);
    const input = `[CEO] once ${randomUUID()} [badjson-once]`;
    const a = await runOnce(roleArgs("coo", { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: [`[文脈] 日時: 1\n${input}`] }), { cwd, env });
    const b = await runOnce(roleArgs("coo", { session: { id: randomUUID(), resume: false }, cwd, stream: false, extra: [`[文脈] 日時: 2\n${input}`] }), { cwd, env });
    expect(parseTurnOutput("coo", structuredOf(a.lines)).ok).toBe(false);
    expect(parseTurnOutput("coo", structuredOf(b.lines)).ok).toBe(true);
  });
});

describe("枠（rate_limit_event。1.4・9 章）", () => {
  it("ふだんは allowed を 1 回、[warn] は allowed_warning（5 時間枠 0.85 以上）", async () => {
    const cwd = ws();
    const ok = await runOnce([...COMMON_ARGS, "hi"], { cwd, env });
    const q = expectValidStream(ok.raw, cwd).quotas;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ status: "allowed" });
    const warn = await runOnce([...COMMON_ARGS, "[warn]"], { cwd, env });
    const w = expectValidStream(warn.raw, cwd).quotas[0];
    expect(w?.status).toBe("allowed_warning");
    expect(w?.fiveHour?.utilization).toBeGreaterThanOrEqual(0.85);
  });

  it("[quota]: rejected と「You've hit your session limit」。戻るまでは他のプロセスも枠切れ、戻ったら通る", async () => {
    const { dir, cleanup } = tempDir();
    const e = cleanEnv(path.join(dir, "state"), { FAKE_QUOTA_RESET_SEC: "1" });
    try {
      const cwd = ws();
      const r = await runOnce([...COMMON_ARGS, "[quota] 台本"], { cwd, env: e });
      expect(r.exit.code).toBe(1);
      const norm = expectValidStream(r.raw, cwd);
      expect(norm.quotas[0]?.status).toBe("rejected");
      expect(norm.items.some((i) => i.summary === "枠切れ")).toBe(true);
      const res = norm.sessions.find((s) => s.kind === "result");
      expect(res?.kind === "result" && res.limitHit).toBe(true);
      const other = await runOnce([...COMMON_ARGS, "別の仕事"], { cwd, env: e });
      expect(other.exit.code).toBe(1);
      await new Promise((r2) => setTimeout(r2, 1300));
      const again = await runOnce([...COMMON_ARGS, "[quota] 台本"], { cwd, env: e });
      expect(again.exit.code).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("メンバーの質問・追加の依頼（5.6）", () => {
  it("[ask]: ask_leader → [リーダー] の答えで --resume → done。終わったあとの [CEO の追加の依頼] でファイルに足す", async () => {
    const cwd = ws();
    const { p, session } = startMember(cwd, memberInput(cwd, "まとめる [ask]", ["notes/"]));
    await p.waitResults(1);
    p.close();
    await p.exited;
    const q = parseTurnOutput("member", structuredOf(p.lines));
    expect(q.ok && q.value).toMatchObject({ kind: "ask_leader" });

    const resumed = { id: session.id, resume: true };
    const a = startMember(cwd, "[リーダー] A 案（箇条書き）で進めてください。", resumed);
    await a.p.waitResults(1);
    a.p.close();
    await a.p.exited;
    const done = parseTurnOutput("member", structuredOf(a.p.lines));
    if (!done.ok || done.value.kind !== "done") throw new Error("done");
    const file = done.value.artifacts[0]!.path;
    expect(file.startsWith("notes/")).toBe(true);

    const f = startMember(cwd, "[CEO の追加の依頼] 最後に一言まとめを足して", resumed);
    await f.p.waitResults(1);
    f.p.close();
    await f.p.exited;
    const norm = expectValidStream(f.p.raw, cwd);
    expect(norm.items.some((i) => i.kind === "tool_result" && i.summary.startsWith(`書き換えた ${file}`))).toBe(true);
    const out = parseTurnOutput("member", structuredOf(f.p.lines));
    expect(out.ok && out.value.kind === "done" && out.value.summary).toContain("追加の依頼に対応しました");
  });

  it("[giveup] は give_up", async () => {
    const cwd = ws();
    const { p } = startMember(cwd, memberInput(cwd, "無理な仕事 [giveup]"));
    await p.waitResults(1);
    p.close();
    await p.exited;
    const out = parseTurnOutput("member", structuredOf(p.lines));
    expect(out.ok && out.value.kind).toBe("give_up");
  });
});
