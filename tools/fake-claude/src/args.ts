// 本物の `claude` と同じ引数を受け取る（DESIGN-v2 1.2・6.1・7.2）。
// 知らないフラグは値を取らないものとして読み飛ばし、標準エラーに書く（本物との差に気づけるように）。

export type FakeArgs = {
  print: boolean;
  outputFormat: "text" | "json" | "stream-json";
  inputFormat: "text" | "stream-json";
  verbose: boolean;
  includePartialMessages: boolean;
  model: string | null;
  fallbackModel: string | null;
  sessionId: string | null;
  resume: string | null;
  permissionMode: string | null;
  permissionPromptTool: string | null;
  tools: string[] | null;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  pluginDirs: string[];
  appendSystemPrompt: string | null;
  systemPrompt: string | null;
  jsonSchema: Record<string, unknown> | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  strictMcpConfig: boolean;
  mcpConfigs: string[];
  settingSources: string | null;
  settings: string | null;
  name: string | null;
  prompt: string | null;
  unknownFlags: string[];
};

/** 次のフラグまで値を集めるもの（commander の variadic と同じ） */
const VARIADIC = new Set(["--tools", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--add-dir", "--mcp-config", "--betas"]);
/** 値を 1 つ取るもの */
const VALUE = new Set([
  "--output-format",
  "--input-format",
  "--model",
  "--fallback-model",
  "--session-id",
  "--resume",
  "-r",
  "--permission-mode",
  "--permission-prompt-tool",
  "--plugin-dir",
  "--append-system-prompt",
  "--system-prompt",
  "--json-schema",
  "--max-turns",
  "--max-budget-usd",
  "--setting-sources",
  "--settings",
  "--name",
  "-n",
  "--permission-prompts",
  "--agents",
  "--effort",
]);
/** 値を取らないもの */
const BOOLEAN = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--dangerously-skip-permissions",
  "--fork-session",
  "--replay-user-messages",
  "--continue",
  "-c",
  "--bare",
]);

/**
 * 道具の並び（"Read,Grep" や "Read Grep" や "Bash(git log *)"）を分ける。
 * 括弧の中の空白・カンマでは切らない。
 */
export function splitToolList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    let depth = 0;
    let cur = "";
    for (const ch of v) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && (ch === "," || ch === " ")) {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

export class ArgError extends Error {}

export function parseArgs(argv: readonly string[]): FakeArgs {
  const a: FakeArgs = {
    print: false,
    outputFormat: "text",
    inputFormat: "text",
    verbose: false,
    includePartialMessages: false,
    model: null,
    fallbackModel: null,
    sessionId: null,
    resume: null,
    permissionMode: null,
    permissionPromptTool: null,
    tools: null,
    allowedTools: [],
    disallowedTools: [],
    addDirs: [],
    pluginDirs: [],
    appendSystemPrompt: null,
    systemPrompt: null,
    jsonSchema: null,
    maxTurns: null,
    maxBudgetUsd: null,
    strictMcpConfig: false,
    mcpConfigs: [],
    settingSources: null,
    settings: null,
    name: null,
    prompt: null,
    unknownFlags: [],
  };
  const positional: string[] = [];
  let i = 0;
  const isFlag = (s: string | undefined) => s !== undefined && s.startsWith("-") && s.length > 1;
  while (i < argv.length) {
    let arg = argv[i]!;
    let inline: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    i += 1;
    if (arg === "--") {
      positional.push(...argv.slice(i));
      break;
    }
    if (!isFlag(arg)) {
      positional.push(arg);
      continue;
    }
    if (BOOLEAN.has(arg)) {
      switch (arg) {
        case "-p":
        case "--print":
          a.print = true;
          break;
        case "--verbose":
          a.verbose = true;
          break;
        case "--include-partial-messages":
          a.includePartialMessages = true;
          break;
        case "--strict-mcp-config":
          a.strictMcpConfig = true;
          break;
        case "--dangerously-skip-permissions":
          a.permissionMode = "bypassPermissions";
          break;
        default:
          break;
      }
      continue;
    }
    if (VARIADIC.has(arg)) {
      const values: string[] = [];
      if (inline !== null) values.push(inline);
      else
        while (i < argv.length && !isFlag(argv[i])) {
          values.push(argv[i]!);
          i += 1;
        }
      switch (arg) {
        case "--tools":
          a.tools = splitToolList(values);
          break;
        case "--allowedTools":
        case "--allowed-tools":
          a.allowedTools.push(...splitToolList(values));
          break;
        case "--disallowedTools":
        case "--disallowed-tools":
          a.disallowedTools.push(...splitToolList(values));
          break;
        case "--add-dir":
          a.addDirs.push(...values);
          break;
        case "--mcp-config":
          a.mcpConfigs.push(...values);
          break;
        default:
          break;
      }
      continue;
    }
    if (VALUE.has(arg)) {
      const value = inline ?? argv[i];
      if (inline === null) i += 1;
      if (value === undefined) throw new ArgError(`error: option '${arg}' argument missing`);
      switch (arg) {
        case "--output-format":
          if (value !== "text" && value !== "json" && value !== "stream-json") throw new ArgError(`error: option '--output-format <format>' argument '${value}' is invalid.`);
          a.outputFormat = value;
          break;
        case "--input-format":
          if (value !== "text" && value !== "stream-json") throw new ArgError(`error: option '--input-format <format>' argument '${value}' is invalid.`);
          a.inputFormat = value;
          break;
        case "--model":
          a.model = value;
          break;
        case "--fallback-model":
          a.fallbackModel = value;
          break;
        case "--session-id":
          a.sessionId = value;
          break;
        case "--resume":
        case "-r":
          a.resume = value;
          break;
        case "--permission-mode":
          a.permissionMode = value;
          break;
        case "--permission-prompt-tool":
          a.permissionPromptTool = value;
          break;
        case "--plugin-dir":
          a.pluginDirs.push(value);
          break;
        case "--append-system-prompt":
          a.appendSystemPrompt = a.appendSystemPrompt === null ? value : `${a.appendSystemPrompt}\n${value}`;
          break;
        case "--system-prompt":
          a.systemPrompt = value;
          break;
        case "--json-schema": {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            throw new ArgError("Error: Invalid JSON provided to --json-schema");
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ArgError("Error: --json-schema must be a JSON object");
          a.jsonSchema = parsed as Record<string, unknown>;
          break;
        }
        case "--max-turns": {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) throw new ArgError(`error: --max-turns must be a positive integer`);
          a.maxTurns = n;
          break;
        }
        case "--max-budget-usd": {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) throw new ArgError(`error: --max-budget-usd must be a positive number`);
          a.maxBudgetUsd = n;
          break;
        }
        case "--setting-sources":
          a.settingSources = value;
          break;
        case "--settings":
          a.settings = value;
          break;
        case "--name":
        case "-n":
          a.name = value;
          break;
        default:
          break;
      }
      continue;
    }
    a.unknownFlags.push(arg);
  }
  if (positional.length > 0) a.prompt = positional.join(" ");
  if (a.sessionId !== null && a.resume !== null) {
    // 本物は --fork-session なしの併用を拒む
    throw new ArgError("Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.");
  }
  if (a.inputFormat === "stream-json" && a.outputFormat !== "stream-json") {
    throw new ArgError("Error: --input-format=stream-json requires output-format=stream-json.");
  }
  if (a.outputFormat === "stream-json" && a.print && !a.verbose) {
    throw new ArgError("Error: When using --print, --output-format=stream-json requires --verbose");
  }
  return a;
}
