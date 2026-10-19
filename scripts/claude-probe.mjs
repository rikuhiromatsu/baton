#!/usr/bin/env node
// 本物の claude（Mac mini の ~/.local/bin/claude、Max サブスク）を haiku で最小の依頼だけ動かし、
// stream-json の実物を packages/shared/test/fixtures/claude/ に保存する（DESIGN-v2 1 章・8.3・18.1 の V0）。
//
//   npm run claude:probe                 # 全部
//   npm run claude:probe -- tools resume # 名前を指定して一部だけ
//
// 守ること:
// - 子の環境は許可リスト（7.7）。ANTHROPIC_* などランナーの環境は渡さない（API 課金にしない）。
// - 作業は一時フォルダで。本人の設定は読ませない（--setting-sources "" --strict-mcp-config）。
// - 保存する前に、メール・トークン・ホームのパスなどを伏せる。
// - 1 回の起動は --max-budget-usd 0.2 で止める。全体で 10 回前後。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/shared/test/fixtures/claude");
const HOME = homedir();
const CLAUDE = process.env.BATON_CLAUDE_BIN ?? join(HOME, ".local/bin/claude");
const MODEL = process.env.PROBE_MODEL ?? "haiku";
const BUDGET = "0.2";

/** 7.7 の許可リストの環境。process.env は引き継がない */
function childEnv() {
  return {
    HOME,
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    TMPDIR: tmpdir(),
    PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    SHELL: "/bin/zsh",
    LANG: "ja_JP.UTF-8",
    TERM: "dumb",
    CLAUDE_CODE_ENABLE_TASKS: "0",
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
  };
}

// ───────────── 伏せる ─────────────

const SECRETS = [];
function addSecret(value, replacement) {
  if (value && value.length >= 4) SECRETS.push([value, replacement]);
}
function redact(text) {
  let out = text;
  for (const [v, r] of [...SECRETS].sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(r);
  return out
    .replace(/\/tmp\/baton-probe-[A-Za-z0-9]{6}/g, "/tmp/baton-probe")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED")
    .replace(/btn_(bot|run)_[A-Za-z0-9_-]+/g, "btn_$1_REDACTED")
    .replace(/"(orgId|organization_uuid|account_uuid|accountUuid|organizationUuid|userID|user_id)":"[^"]*"/g, '"$1":"REDACTED"');
}

// ───────────── 実行 ─────────────

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["done"] },
    summary: { type: "string" },
  },
  required: ["kind", "summary"],
  additionalProperties: false,
};

const BASE = [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--model", MODEL,
  "--setting-sources", "",
  "--strict-mcp-config",
  "--max-budget-usd", BUDGET,
];

/**
 * 1 回起動して stdout の行を集める。
 * stdin: "close"（すぐ閉じる）か、stream-json 入力の対話 fn(send, line) を受ける。
 */
function run({ name, args, cwd, prompt, interact, timeoutMs = 180_000 }) {
  return new Promise((resolveRun) => {
    const fullArgs = [...BASE, ...args];
    if (prompt !== undefined) fullArgs.push(prompt);
    const child = spawn(CLAUDE, fullArgs, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const lines = [];
    const sent = [];
    const startedAt = Date.now();
    let stderr = "";
    const send = (obj) => {
      const line = JSON.stringify(obj);
      sent.push(line);
      child.stdin.write(line + "\n");
    };
    const close = () => {
      if (!child.stdin.writableEnded) child.stdin.end();
    };
    const timer = setTimeout(() => {
      stderr += "\n[probe] timeout → SIGTERM";
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (interact) interact({ send, close, msg, child, elapsed: Date.now() - startedAt });
    });
    if (!interact) close();
    else interact({ send, close, msg: null, child, elapsed: 0 });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ name, args: fullArgs, lines, sent, stderr, code, signal, durationMs: Date.now() - startedAt });
    });
  });
}

function save(res, cwd) {
  addSecret(cwd, "/tmp/baton-probe");
  addSecret(realpathSync(cwd), "/tmp/baton-probe");
  const jsonl = res.lines.map(redact).join("\n") + "\n";
  writeFileSync(join(OUT, `${res.name}.jsonl`), jsonl);
  if (res.sent.length) writeFileSync(join(OUT, `${res.name}.stdin.jsonl`), res.sent.map(redact).join("\n") + "\n");
  const types = {};
  let cost = 0;
  let result = null;
  for (const l of res.lines) {
    try {
      const m = JSON.parse(l);
      const key = m.type === "system" || m.type === "control_request" || m.type === "control_response"
        ? `${m.type}/${m.subtype ?? m.request?.subtype ?? m.response?.subtype ?? "?"}`
        : m.type === "stream_event" ? `stream_event/${m.event?.type}` : m.type;
      types[key] = (types[key] ?? 0) + 1;
      if (m.type === "result") {
        cost += m.total_cost_usd ?? 0;
        result = { subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, terminal_reason: m.terminal_reason };
      }
    } catch {
      types["(not json)"] = (types["(not json)"] ?? 0) + 1;
    }
  }
  return {
    name: res.name,
    args: JSON.parse(redact(JSON.stringify(res.args.map((a) => (a.length > 300 ? a.slice(0, 300) + "…" : a))))),
    exitCode: res.code,
    signal: res.signal,
    durationMs: res.durationMs,
    costUsdEst: Math.round(cost * 10000) / 10000,
    result,
    lineTypes: types,
    stderrTail: redact(res.stderr.slice(-400)),
  };
}

// ───────────── 準備 ─────────────

const WORKDIRS = [];
function makeWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), "baton-probe-"));
  WORKDIRS.push(dir);
  writeFileSync(join(dir, "notes.md"), "# メモ\n\nコーヒーの産地: エチオピア、ケニア、グアテマラ\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const greeting = \"hello\";\n");
  return dir;
}

/** --plugin-dir の形（6.1）。本人のスキルを写す。無ければ小さな試験用スキルを作る */
function makePluginDir(base) {
  const dir = join(base, ".probe-plugin");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "baton-probe" }));
  const src = join(HOME, ".claude/skills/sns-url-research");
  try {
    cpSync(realpathSync(src), join(dir, "skills/sns-url-research"), { recursive: true, dereference: true });
  } catch {
    mkdirSync(join(dir, "skills/probe-skill"), { recursive: true });
    writeFileSync(
      join(dir, "skills/probe-skill/SKILL.md"),
      "---\nname: probe-skill\ndescription: 試験用のスキル\n---\n\n試験用。\n",
    );
  }
  return dir;
}

const ROLE_PROMPT = "ROLE: member\nあなたは Baton の試験用メンバー。日本語で短く答える。最後に必ず StructuredOutput を呼ぶ。";

// ───────────── 場面 ─────────────

const SCENARIOS = {
  /** init・各道具・TodoWrite・StructuredOutput・stream_event・rate_limit_event・--plugin-dir・--strict-mcp-config */
  async tools(state) {
    const cwd = makeWorkdir();
    const plugin = makePluginDir(cwd);
    state.sessionId = randomUUID();
    state.cwd = cwd;
    const res = await run({
      name: "tools",
      cwd,
      args: [
        "--session-id", state.sessionId,
        "--include-partial-messages",
        "--permission-mode", "dontAsk",
        "--tools", "Read,Grep,Glob,Edit,Write,Bash,TodoWrite,Skill",
        "--allowedTools", "Read", "Grep", "Glob", "TodoWrite", "Skill", `Edit(/${cwd}/**)`, `Write(/${cwd}/**)`, "Bash(ls *)", "Bash(wc *)",
        "--plugin-dir", plugin,
        "--append-system-prompt", ROLE_PROMPT,
        "--json-schema", JSON.stringify(SCHEMA),
        "--max-turns", "16",
      ],
      prompt:
        "次の順に道具を 1 回ずつ使ってください。前置きは書かないこと。\n" +
        "1. TodoWrite で 3 項目の TODO を作る\n2. Glob で **/*.md を探す\n3. Read で notes.md を読む\n" +
        "4. Grep で greeting を探す\n5. Edit で src/a.ts の hello を こんにちは に変える\n" +
        "6. Write で out.md に産地を 1 行ずつ書く\n7. Bash で `wc -l out.md`\n8. TodoWrite で全部完了にする\n" +
        "最後に一言だけ書いてから StructuredOutput（kind: done、summary は 20 文字以内）。",
    });
    return save(res, cwd);
  },

  /** --resume で同じセッションの続き（json-schema と組み合わせ） */
  async resume(state) {
    if (!state.sessionId) return { name: "resume", skipped: "tools が先に要る" };
    const res = await run({
      name: "resume",
      cwd: state.cwd,
      args: [
        "--resume", state.sessionId,
        "--permission-mode", "dontAsk",
        "--tools", "Read",
        "--allowedTools", "Read",
        "--append-system-prompt", ROLE_PROMPT,
        "--json-schema", JSON.stringify(SCHEMA),
        "--max-turns", "4",
      ],
      prompt: "さっき out.md に何行書いたか、道具を使わずに答えて StructuredOutput を返して。",
    });
    return save(res, state.cwd);
  },

  /**
   * stream-json 入力・制御プロトコル: initialize → 1 通目 → 承認（can_use_tool → allow）→ result
   * → 2 通目（拒否）→ result → 3 通目の途中で interrupt → result → 閉じる
   */
  async approval() {
    const cwd = makeWorkdir();
    let phase = 0;
    const res = await run({
      name: "approval",
      cwd,
      args: [
        "--session-id", randomUUID(),
        "--input-format", "stream-json",
        "--include-partial-messages",
        "--permission-mode", "manual",
        "--permission-prompt-tool", "stdio",
        "--tools", "Read,Bash",
        "--allowedTools", "Read",
        "--append-system-prompt", "ROLE: leader\n日本語で短く答える。",
        "--max-turns", "6",
      ],
      interact: ({ send, close, msg }) => {
        if (msg === null) {
          send({ type: "control_request", request_id: "req_init", request: { subtype: "initialize" } });
          send({ type: "user", message: { role: "user", content: "Bash で `echo probe > approved.txt` を 1 回だけ実行して、結果を一言で。" } });
          return;
        }
        if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
          const allow = phase === 0;
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: msg.request_id,
              response: allow
                ? { behavior: "allow", updatedInput: msg.request.input }
                : { behavior: "deny", message: "CEO が拒否しました（試験）" },
            },
          });
          return;
        }
        if (msg.type === "result") {
          phase += 1;
          if (phase === 1) {
            send({ type: "user", message: { role: "user", content: "次に Bash で `echo second > denied.txt` を 1 回だけ実行して。拒否されたら一言で報告して。" } });
          } else if (phase === 2) {
            send({ type: "user", message: { role: "user", content: "産地について 300 文字くらいで説明して。" } });
            setTimeout(() => send({ type: "control_request", request_id: "req_int", request: { subtype: "interrupt" } }), 2500);
          } else {
            close();
          }
        }
      },
    });
    return save(res, cwd);
  },

  /** 権限で拒否（dontAsk）・permission_denials・WebFetch */
  async denied() {
    const cwd = makeWorkdir();
    const res = await run({
      name: "denied",
      cwd,
      args: [
        "--permission-mode", "dontAsk",
        "--tools", "Read,Bash,WebFetch",
        "--allowedTools", "Read", "WebFetch(domain:example.com)",
        "--disallowedTools", "Bash(rm *)",
        "--max-turns", "6",
      ],
      prompt: "1. Bash で `rm notes.md` を実行して。2. WebFetch で https://example.com のタイトルを取って。最後に結果を一言で。",
    });
    return save(res, cwd);
  },

  /** --max-turns で止まる（error_max_turns） */
  async maxturns() {
    const cwd = makeWorkdir();
    const res = await run({
      name: "maxturns",
      cwd,
      args: ["--permission-mode", "dontAsk", "--tools", "Read,Glob", "--allowedTools", "Read", "Glob", "--max-turns", "1"],
      prompt: "Glob で *.md を探してから、見つけたファイルを Read で全部読んで要約して。",
    });
    return save(res, cwd);
  },

  /** 本物の CooTurn の JSON Schema（discriminatedUnion → oneOf）が --json-schema で通るか。道具なし・ストリーミング */
  async "coo-schema"() {
    const cwd = makeWorkdir();
    const { turnJsonSchema } = await import("../packages/shared/src/structured-output.ts");
    const { buildThreadTurnInput } = await import("../packages/shared/src/turn-input.ts");
    const res = await run({
      name: "coo-schema",
      cwd,
      args: [
        "--session-id", randomUUID(),
        "--include-partial-messages",
        "--permission-mode", "dontAsk",
        "--tools", "",
        "--append-system-prompt",
        "ROLE: coo\nあなたは Baton という組織の COO。CEO の窓口。返事は日本語で短く、チャットのテンポで。目的が曖昧なら短い質問を 1 つだけ返し、actions は空、awaitingReply は true。最後に必ず StructuredOutput。",
        "--json-schema", JSON.stringify(turnJsonSchema("coo")),
        "--max-turns", "4",
      ],
      prompt: buildThreadTurnInput({
        threadKind: "coo",
        now: Date.UTC(2026, 9, 21, 1, 12),
        inbox: [{ kind: "ceo_message", instructionId: null, payload: { body: "ショート動画の台本 10 本作りたい" } }],
        instructions: [],
      }),
    });
    return save(res, cwd);
  },

  /** MemberOutput（kind の discriminatedUnion）が通るか */
  async "member-schema"() {
    const cwd = makeWorkdir();
    const { turnJsonSchema } = await import("../packages/shared/src/structured-output.ts");
    const res = await run({
      name: "member-schema",
      cwd,
      args: [
        "--permission-mode", "dontAsk",
        "--tools", "Read",
        "--allowedTools", "Read",
        "--append-system-prompt", ROLE_PROMPT,
        "--json-schema", JSON.stringify(turnJsonSchema("member")),
        "--max-turns", "4",
      ],
      prompt: "[タスク] notes.md を読み、産地を 3 つ挙げて done で終える（artifacts は notes.md を 1 つ）。",
    });
    return save(res, cwd);
  },

  /** 道具なし・WebSearch（調べた語の要約用） */
  async websearch() {
    const cwd = makeWorkdir();
    const res = await run({
      name: "websearch",
      cwd,
      args: ["--permission-mode", "dontAsk", "--tools", "WebSearch", "--allowedTools", "WebSearch", "--max-turns", "4"],
      prompt: "WebSearch で「エチオピア コーヒー 産地」を 1 回だけ調べ、一言で答えて。",
    });
    return save(res, cwd);
  },
};

// ───────────── 本体 ─────────────

async function main() {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(SCENARIOS);
  mkdirSync(OUT, { recursive: true });
  addSecret(HOME, "/Users/me");
  addSecret(realpathSync(tmpdir()), "/tmp");
  addSecret(tmpdir(), "/tmp");
  addSecret(userInfo().username, "me");

  const manifestPath = join(OUT, "manifest.json");
  let manifest = { claudeVersion: null, model: MODEL, recordedAt: null, runs: {} };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {}

  const state = {};
  for (const name of names) {
    const fn = SCENARIOS[name];
    if (!fn) throw new Error(`知らない場面: ${name}`);
    process.stderr.write(`[probe] ${name} …\n`);
    const summary = await fn(state);
    manifest.runs[name] = summary;
    process.stderr.write(`[probe] ${name}: ${JSON.stringify({ cost: summary.costUsdEst, result: summary.result, types: summary.lineTypes })}\n`);
  }
  for (const line of readFileSync(join(OUT, `${names[0]}.jsonl`), "utf8").split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m.type === "system" && m.subtype === "init") manifest.claudeVersion = m.claude_code_version;
    } catch {}
  }
  manifest.model = MODEL;
  manifest.recordedAt = new Date().toISOString().slice(0, 10);
  manifest.totalCostUsdEst = Math.round(Object.values(manifest.runs).reduce((s, r) => s + (r.costUsdEst ?? 0), 0) * 10000) / 10000;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  for (const d of WORKDIRS) rmSync(d, { recursive: true, force: true });
  process.stderr.write(`[probe] 合計の推定額 $${manifest.totalCostUsdEst}\n`);
}

await main();
