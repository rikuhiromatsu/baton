// 偽 claude（DESIGN-v2 15.2）。本物の `claude -p --output-format stream-json …` と同じ引数を受け、同じ形の stream-json を台本どおりに出す。
//
// 使い方: ランナー・E2E は BATON_CLAUDE_BIN=<repo>/tools/fake-claude/bin/claude を渡す。
// 環境変数:
//   FAKE_CLAUDE_STATE_DIR      セッションと枠切れの状態（既定: OS の一時フォルダ/fake-claude-state）
//   FAKE_CLAUDE_STEP_MS        1 手ごとの待ち（既定 30）。FAKE_CLAUDE_DELTA_MS 文字の差分ごとの待ち（既定 15）
//   FAKE_CLAUDE_SLOW_MS / FAKE_CLAUDE_SLOW_DELTA_MS  [slow] のときの待ち（既定 1500 / 150）
//   FAKE_QUOTA_RESET_SEC       [quota] の枠切れが戻るまでの秒（既定 60）
//   FAKE_FIVE_HOUR_UTIL / FAKE_SEVEN_DAY_UTIL  rate_limit_event の利用率（既定 0.2 / 0.1）
//   FAKE_CLAUDE_REPO_PATH      [propose][repo] で COO が出す repoPath
//   FAKE_CLAUDE_AUTH=none      `claude auth status` をログアウト扱いにする
//   FAKE_CLAUDE_LONG_STEPS     [long] で前に足す道具の数（既定 60）
// ANTHROPIC_API_KEY・ANTHROPIC_AUTH_TOKEN・BATON_RUNNER_TOKEN が環境にあれば異常終了する（ランナーが子の環境から外していることの検査。7.7）。
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import readline from "node:readline";
import { ArgError, parseArgs } from "./args.ts";
import { FAKE_VERSION } from "./emit.ts";
import { Engine } from "./engine.ts";
import { loadSession, newSession, saveSession, sessionExists } from "./store.ts";

/** 子の環境に渡ってはいけないもの（7.7） */
export const FORBIDDEN_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "BATON_RUNNER_TOKEN"] as const;
export const EXIT_FORBIDDEN_ENV = 3;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  process.stdout.on("error", () => process.exit(0));

  const leaked = FORBIDDEN_ENV.filter((k) => process.env[k] !== undefined);
  if (leaked.length > 0) fail(`fake-claude: 子の環境に ${leaked.join("・")} があります（ランナーは渡してはいけない。DESIGN-v2 7.7）`, EXIT_FORBIDDEN_ENV);

  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${FAKE_VERSION} (Claude Code)\n`);
    return;
  }
  if (argv[0] === "auth" && argv[1] === "status") {
    const loggedIn = process.env.FAKE_CLAUDE_AUTH !== "none";
    process.stdout.write(
      `${JSON.stringify(loggedIn ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2)}\n`,
    );
    process.exitCode = loggedIn ? 0 : 1;
    return;
  }

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) fail(e.message);
    throw e;
  }
  if (!args.print) fail("fake-claude: 対話モードは扱いません（-p を付けてください）");
  for (const f of args.unknownFlags) process.stderr.write(`fake-claude: 知らないフラグを読み飛ばしました: ${f}\n`);

  const cwd = realpathSync(process.cwd());
  let session;
  try {
    if (args.resume) {
      session = loadSession(args.resume);
      if (!session) fail(`No conversation found with session ID: ${args.resume}`);
      if (session.cwd !== cwd) process.stderr.write(`fake-claude: 警告: セッション ${args.resume} は ${session.cwd} で作られ、${cwd} から再開されました\n`);
    } else {
      const id = args.sessionId ?? randomUUID();
      if (sessionExists(id)) fail(`Error: Session ID ${id} is already in use.`);
      session = newSession(id, cwd);
      saveSession(session);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const lines: unknown[] = [];
  const write =
    args.outputFormat === "stream-json"
      ? (obj: unknown) => {
          process.stdout.write(`${JSON.stringify(obj)}\n`);
        }
      : (obj: unknown) => {
          lines.push(obj);
        };
  const engine = new Engine({ args, env: process.env, cwd, session, write });

  const readsStdin = args.inputFormat === "stream-json" || args.permissionPromptTool === "stdio";
  let prompt = args.prompt;
  if (args.inputFormat !== "stream-json" && prompt === null) prompt = await readAllStdin();
  let rl: readline.Interface | null = null;
  if (readsStdin && !process.stdin.readableEnded) {
    rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (l) => engine.onLine(l));
    rl.on("close", () => engine.onEnd());
  } else engine.onEnd();

  await engine.run(prompt);
  rl?.close();
  process.stdin.destroy();

  if (args.outputFormat === "json" && engine.lastResult) process.stdout.write(`${JSON.stringify(engine.lastResult)}\n`);
  if (args.outputFormat === "text" && engine.lastResult) process.stdout.write(`${String(engine.lastResult.result ?? "")}\n`);
  process.exitCode = engine.lastResultError ? 1 : 0;
}

main().catch((e: unknown) => {
  process.stderr.write(`fake-claude: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
