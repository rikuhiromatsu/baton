// S5 normalizeStreamLine（DESIGN-v2 8.3）。実物の記録（scripts/claude-probe.mjs、claude 2.1.303・haiku）で確かめる。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUOTA,
  applyQuotaObservation,
  approvalItem,
  canStartMemberSession,
  canStartThreadTurn,
  initialNormalizeState,
  normalizeStreamLine,
  normalizeStreamLines,
  parseStreamLine,
  parseTurnOutput,
  toolActivity,
  toolSummary,
  type SessionInitInfo,
  type SessionResultInfo,
} from "../src/index.ts";

const FIX = join(import.meta.dirname, "fixtures/claude");
const lines = (name: string) => readFileSync(join(FIX, `${name}.jsonl`), "utf8").split("\n").filter((l) => l.trim());
const CWD = "/tmp/baton-probe";

describe("S5 stream-json の読み取り（claude-stream.ts）", () => {
  it("記録のすべての行が知っている型として読める（unknown・invalid が無い）", () => {
    for (const name of ["tools", "resume", "approval", "denied", "maxturns", "websearch", "coo-schema", "member-schema"]) {
      for (const line of lines(name)) {
        const m = parseStreamLine(line);
        expect(m.kind, `${name}: ${line.slice(0, 120)}`).not.toBe("unknown");
        expect(m.kind).not.toBe("invalid");
      }
    }
  });

  it("壊れた行は invalid、知らない type は unknown（落ちない）", () => {
    expect(parseStreamLine("{not json").kind).toBe("invalid");
    expect(parseStreamLine('{"type":"brand_new_event","x":1}').kind).toBe("unknown");
    const r = normalizeStreamLine('{"type":"brand_new_event"}', initialNormalizeState(CWD));
    expect(r.items).toEqual([]);
  });
});

describe("S5 normalizeStreamLine（transcript.ts）", () => {
  it("init: 開始の項目と、apiKeySource・MCP・スキル（--plugin-dir）・--strict-mcp-config の確認材料", () => {
    const r = normalizeStreamLines(lines("tools"));
    const init = r.sessions.find((s): s is SessionInitInfo => s.kind === "init")!;
    expect(init.apiKeySource).toBe("none");
    expect(init.mcpServers).toEqual([]);
    expect(init.skills).toContain("baton-probe:sns-url-research");
    expect(init.plugins).toContain("baton-probe");
    expect(init.tools).toEqual(expect.arrayContaining(["Read", "Edit", "Write", "Bash", "TodoWrite", "Skill", "StructuredOutput"]));
    expect(init.claudeCodeVersion).toBe("2.1.303");
    const first = r.items[0]!;
    expect(first).toMatchObject({ kind: "system", summary: "開始" });
    expect(first.body).toMatchObject({ cwd: CWD, mcpCount: 0, permissionMode: "dontAsk" });
  });

  it("各道具の要約は日本語の固定動詞・相対パス（D-59）", () => {
    const r = normalizeStreamLines(lines("tools"));
    const uses = r.items.filter((i) => i.kind === "tool_use").map((i) => i.summary);
    expect(uses).toEqual([
      "TODO を更新",
      "検索した **/*.md",
      "読んだ notes.md",
      "検索した greeting",
      "編集した src/a.ts",
      "作成した out.md",
      "実行した wc -l out.md",
      "TODO を更新",
    ]);
  });

  it("Edit・Write の結果は差分（originalFile は捨てる）、Bash は stdout/stderr", () => {
    const r = normalizeStreamLines(lines("tools"));
    const results = r.items.filter((i) => i.kind === "tool_result");
    const edit = results.find((i) => i.toolName === "Edit")!;
    expect(edit.summary).toBe("編集した src/a.ts（+1 −1）");
    expect(edit.body).toMatchObject({ filePath: "src/a.ts", type: "edit", added: 1, removed: 1 });
    expect(String(edit.body.patch)).toContain("+export const greeting = \"こんにちは\";");
    expect(JSON.stringify(edit.body)).not.toContain("originalFile");
    const write = results.find((i) => i.toolName === "Write")!;
    expect(write.summary).toBe("作成した out.md（+3 −0）");
    expect(write.body).toMatchObject({ type: "create", filePath: "out.md" });
    const bash = results.find((i) => i.toolName === "Bash")!;
    expect(bash.body).toEqual({ stdout: expect.stringContaining("3 out.md"), stderr: "" });
    // TodoWrite と StructuredOutput の受け取りの定型文は項目にしない
    expect(results.some((i) => i.toolName === "TodoWrite" || i.toolName === "StructuredOutput")).toBe(false);
  });

  it("StructuredOutput は output（結論）になり、result.structured_output が MemberOutput の検査を通る", () => {
    const r = normalizeStreamLines(lines("member-schema"));
    const out = r.items.find((i) => i.kind === "output")!;
    expect(out.summary).toBe("結論");
    const res = r.sessions.find((s): s is SessionResultInfo => s.kind === "result")!;
    const parsed = parseTurnOutput("member", res.structuredOutput);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.kind).toBe("done");
  });

  it("COO のターン（--json-schema に CooTurn、道具なし）の結果が CooTurn の検査を通る", () => {
    const r = normalizeStreamLines(lines("coo-schema"));
    const res = r.sessions.find((s): s is SessionResultInfo => s.kind === "result")!;
    const parsed = parseTurnOutput("coo", res.structuredOutput);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.awaitingReply).toBe(true);
      expect(parsed.value.actions).toEqual([]);
    }
  });

  it("result: 終了の項目とセッションの集計", () => {
    const r = normalizeStreamLines(lines("tools"));
    const res = r.sessions.find((s): s is SessionResultInfo => s.kind === "result")!;
    expect(res).toMatchObject({ subtype: "success", isError: false, numTurns: 10, limitHit: false, terminalReason: "completed" });
    expect(res.costUsdEst).toBeGreaterThan(0);
    expect(res.tokensOut).toBeGreaterThan(0);
    // 返事の本文＝最後の道具の呼び出し（StructuredOutput を除く）より後の文章（D-76）
    expect(res.replyText).toBe("全手順を完了しました。out.md は 3 行です。");
    const last = r.items.at(-1)!;
    expect(last).toMatchObject({ kind: "result", summary: "終了" });
  });

  it("--include-partial-messages: text_delta は delta、道具の呼び出しの始まりは reset", () => {
    const r = normalizeStreamLines(lines("tools"));
    const texts = r.deltas.filter((d) => d.type === "text");
    const resets = r.deltas.filter((d) => d.type === "reset");
    expect(texts.length).toBeGreaterThan(0);
    expect(resets.length).toBe(8); // 道具の呼び出し（StructuredOutput は数えない）
    // 継ぎ足した文字列は、最後の reset のあとが返事の本文と一致する
    let streamed = "";
    for (const d of r.deltas) streamed = d.type === "reset" ? "" : streamed + d.text;
    expect(streamed).toBe("全手順を完了しました。out.md は 3 行です。");
    // haiku の COO は文章を書かず reply に入れた（ランナーは reply を本文の予備に使う。4.7）
    const coo = normalizeStreamLines(lines("coo-schema"));
    expect(coo.deltas.some((d) => d.type === "text")).toBe(false);
  });

  it("rate_limit_event は quota（秒 → ミリ秒、unifiedWindows を使う）", () => {
    const r = normalizeStreamLines(lines("tools"));
    expect(r.quotas).toHaveLength(1);
    const q = r.quotas[0]!;
    expect(q.status).toBe("allowed");
    expect(q.rateLimitType).toBe("five_hour");
    expect(q.resetsAt).toBe(1792437000 * 1000);
    expect(q.fiveHour?.utilization).toBeGreaterThan(0);
    expect(q.sevenDay?.resetsAt).toBeGreaterThan(q.resetsAt!);
  });

  it("--resume で同じセッション ID のまま続く", () => {
    const t = normalizeStreamLines(lines("tools")).sessions.find((s) => s.kind === "init")!;
    const r = normalizeStreamLines(lines("resume")).sessions.find((s) => s.kind === "init")!;
    expect(r.sessionId).toBe(t.sessionId);
  });

  it("承認: can_use_tool の control、許可・拒否のあとの結果、interrupt の応答と中断", () => {
    const r = normalizeStreamLines(lines("approval"));
    const asks = r.controls.filter((c) => c.kind === "can_use_tool");
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({ toolName: "Bash", input: { command: "echo probe > approved.txt" } });
    const responses = r.controls.filter((c) => c.kind === "response");
    expect(responses.map((c) => c.requestId)).toEqual(["req_init", "req_int"]);
    // 拒否された呼び出しは result.permission_denials に入る
    const results = r.sessions.filter((s): s is SessionResultInfo => s.kind === "result");
    expect(results).toHaveLength(3);
    expect(results[1]!.permissionDenials).toEqual([{ toolName: "Bash", toolUseId: expect.any(String) }]);
    expect(results[2]).toMatchObject({ subtype: "error_during_execution", terminalReason: "aborted_streaming" });
    expect(r.items.some((i) => i.kind === "system" && i.summary === "中断")).toBe(true);
    // stream-json 入力で 3 ターン回っても同じセッション
    const inits = r.sessions.filter((s) => s.kind === "init");
    expect(new Set(inits.map((s) => s.sessionId)).size).toBe(1);
  });

  it("承認の項目はランナーが decisionId を付けて作る", () => {
    const it = approvalItem({ decisionId: "d1", toolName: "Bash", toolInput: { command: "npm install zod" }, toolUseId: "t1", cwd: CWD });
    expect(it).toMatchObject({ kind: "approval", summary: "承認待ち: Bash npm install zod", body: { decisionId: "d1", toolName: "Bash" } });
  });

  it("dontAsk の拒否は denied（拒否: …）と result.permission_denials", () => {
    const r = normalizeStreamLines(lines("denied"));
    const denied = r.items.find((i) => i.kind === "denied")!;
    expect(denied.summary).toBe("拒否: Bash rm notes.md && ls -l notes.md 2>&1");
    expect(denied.body).toMatchObject({ toolName: "Bash" });
    const fetch = r.items.find((i) => i.kind === "tool_use" && i.toolName === "WebFetch")!;
    expect(fetch.summary).toBe("取得した example.com");
  });

  it("WebSearch は「調べた <語>」", () => {
    const r = normalizeStreamLines(lines("websearch"));
    expect(r.items.find((i) => i.kind === "tool_use")!.summary).toBe("調べた エチオピア コーヒー 産地");
  });

  it("--max-turns で止まると error_max_turns", () => {
    const r = normalizeStreamLines(lines("maxturns"));
    const res = r.sessions.find((s): s is SessionResultInfo => s.kind === "result")!;
    expect(res).toMatchObject({ subtype: "error_max_turns", isError: true });
  });

  it("空の thinking は項目にしない（いまの動きは「考えている」）", () => {
    const r = normalizeStreamLines(lines("tools"));
    expect(r.items.some((i) => i.kind === "thinking")).toBe(false);
  });

  it("いまの動き（現在形）", () => {
    expect(toolActivity("Read", { file_path: `${CWD}/src/a.ts` }, CWD)).toBe("読んでいる src/a.ts");
    expect(toolActivity("Grep", { pattern: "x" }, CWD)).toBe("検索している");
    expect(toolActivity("Bash", { command: "npm test" }, CWD)).toBe("実行している npm test");
    expect(toolActivity("TodoWrite", {}, CWD)).toBeNull();
    expect(toolSummary("Skill", { skill: "sns-url-research" }, CWD)).toBe("使った sns-url-research");
    expect(toolSummary("Read", { file_path: "/etc/hosts" }, CWD)).toBe("読んだ /etc/hosts");
  });

  it("枠切れの文と rejected", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 3:45pm" });
    const r = normalizeStreamLine(line, initialNormalizeState(CWD));
    expect((r.session as SessionResultInfo).limitHit).toBe(true);
    const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 2000, rateLimitType: "five_hour" } });
    const q = normalizeStreamLine(rejected, initialNormalizeState(CWD));
    expect(q.items[0]).toMatchObject({ kind: "system", summary: "枠切れ" });
  });
});

describe("S5 枠（9.2）", () => {
  const now = 1_000_000;
  it("しきい値を超えたらメンバーの起動を止める。スレッドのターンは続ける", () => {
    const q = applyQuotaObservation(
      EMPTY_QUOTA,
      { status: "allowed", rateLimitType: "five_hour", resetsAt: now + 3600_000, utilization: 0.85, fiveHour: { utilization: 0.85, resetsAt: now + 3600_000 }, sevenDay: { utilization: 0.3, resetsAt: null } },
      now,
    );
    expect(q.paused).toBe(true);
    expect(canStartMemberSession(q, now)).toBe(false);
    expect(canStartThreadTurn(q, now)).toBe(true);
    const ok = applyQuotaObservation(EMPTY_QUOTA, { status: "allowed", rateLimitType: "seven_day", resetsAt: null, utilization: 0.89, fiveHour: null, sevenDay: null }, now);
    expect(ok.paused).toBe(false);
    expect(canStartMemberSession(ok, now)).toBe(true);
  });

  it("rejected は resetsAt ＋ 60 秒まで止める（無ければ 30 分）", () => {
    const q = applyQuotaObservation(EMPTY_QUOTA, { status: "rejected", rateLimitType: "five_hour", resetsAt: now + 1000, utilization: 1, fiveHour: null, sevenDay: null }, now);
    expect(q.blockedUntil).toBe(now + 1000 + 60_000);
    expect(canStartThreadTurn(q, now)).toBe(false);
    expect(canStartThreadTurn(q, now + 61_000)).toBe(true);
    const hit = applyQuotaObservation(EMPTY_QUOTA, { status: "rejected", limitHit: true }, now);
    expect(hit.blockedUntil).toBe(now + 30 * 60_000);
  });
});
