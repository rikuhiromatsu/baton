// ターンを回す本体: 台本の手を stream-json にして書き、道具を実行し、承認（can_use_tool）と中断（interrupt）を受ける。
// 入力が stream-json なら result のあとも次の user を待つ（標準入力が閉じたら終わる。1.2・5.3）。
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { INTERRUPTED_USER_TEXT, STRUCTURED_OUTPUT_TOOL, TURN_TAGS, parseTurnInput } from "@baton/shared";
import type { FakeArgs } from "./args.ts";
import {
  FAKE_VERSION,
  assistantLine,
  clockText,
  messageDelta,
  messageId,
  messageStart,
  rateLimitLine,
  resolveModel,
  sampleFromSchema,
  streamEvent,
  toolUseId,
  userTextLine,
  userToolResultLine,
  usage,
} from "./emit.ts";
import { evaluatePermission, parseRule } from "./rules.ts";
import { STICKY_MARKERS, parseMarkers } from "./scripts/common.ts";
import { detectRole, scriptFor } from "./scripts/index.ts";
import type { Role, Step, StepResult, TurnContext } from "./scripts/types.ts";
import { loadGlobal, saveSession, takeOnce, updateGlobal, type SessionState } from "./store.ts";
import { runTool } from "./tools.ts";

export const DEFAULT_TOOLS = ["Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Skill", "TodoWrite", "WebFetch", "WebSearch", "Write"];
const BUILTIN_SKILLS = ["deep-research", "code-review"];

class Interrupted extends Error {}

type PermissionReply = { subtype: string; response?: Record<string, unknown>; error?: string } | { subtype: "aborted" };

export type EngineOptions = {
  args: FakeArgs;
  env: NodeJS.ProcessEnv;
  cwd: string;
  session: SessionState;
  write: (obj: unknown) => void;
};

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** 1 回だけのマーカーの鍵: 入力の「中身」の行（[文脈]・[指示の状態] は時刻や版で変わるので除く） */
function onceKey(ctx: TurnContext): string {
  const subject = ctx.lines.filter((l) => l.tag !== TURN_TAGS.context && l.tag !== TURN_TAGS.instructionState && l.tag !== TURN_TAGS.runner);
  return `${ctx.role ?? "none"}\n${subject.length ? subject.map((l) => `${l.tag}${l.text}`).join("\n") : ctx.input}`;
}

export class Engine {
  private readonly args: FakeArgs;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly session: SessionState;
  private readonly write: (obj: unknown) => void;
  private readonly model: string;
  private readonly partial: boolean;
  private readonly stepMs: number;
  private readonly deltaMs: number;
  private readonly slowMs: number;
  private readonly slowDeltaMs: number;
  private mode: string;

  private queue: string[] = [];
  private followUps: string[] = [];
  private inputWaiter: (() => void) | null = null;
  private stdinClosed = false;
  private turn: { abort: AbortController } | null = null;
  private permissionWaiters = new Map<string, (r: PermissionReply) => void>();
  /** rate_limit_event はプロセスで最初の応答のあと 1 回（実物）。[warn] のターンでは毎回 */
  private rateLimitPending = true;
  private warn = false;
  lastResultError = false;
  /** --output-format json / text のときに最後に書く result */
  lastResult: Record<string, unknown> | null = null;

  constructor(o: EngineOptions) {
    this.args = o.args;
    this.env = o.env;
    this.cwd = o.cwd;
    this.session = o.session;
    this.write = o.write;
    this.model = resolveModel(o.args.model);
    this.partial = o.args.includePartialMessages && o.args.outputFormat === "stream-json";
    this.stepMs = num(o.env.FAKE_CLAUDE_STEP_MS, 30);
    this.deltaMs = num(o.env.FAKE_CLAUDE_DELTA_MS, 15);
    this.slowMs = num(o.env.FAKE_CLAUDE_SLOW_MS, 1500);
    this.slowDeltaMs = num(o.env.FAKE_CLAUDE_SLOW_DELTA_MS, 150);
    // manual は init で default と出る（D-99）
    this.mode = o.args.permissionMode === "manual" || !o.args.permissionMode ? "default" : o.args.permissionMode;
  }

  // ───────────── 標準入力 ─────────────

  onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(`fake-claude: 標準入力の行が JSON ではありません: ${line.slice(0, 200)}\n`);
      return;
    }
    switch (msg.type) {
      case "user": {
        const text = contentText((msg.message as { content?: unknown } | undefined)?.content);
        if (this.turn) this.followUps.push(text);
        else {
          this.queue.push(text);
          this.wake();
        }
        return;
      }
      case "control_request":
        this.handleControl(msg);
        return;
      case "control_response": {
        const r = (msg.response ?? {}) as { request_id?: string; subtype?: string; response?: Record<string, unknown>; error?: string };
        const waiter = r.request_id ? this.permissionWaiters.get(r.request_id) : undefined;
        if (waiter && r.request_id) {
          this.permissionWaiters.delete(r.request_id);
          waiter({ subtype: r.subtype ?? "error", response: r.response, error: r.error });
        }
        return;
      }
      default:
        return;
    }
  }

  onEnd(): void {
    this.stdinClosed = true;
    this.wake();
    // 承認を待っているあいだに閉じられたら、そのターンは中断扱い
    if (this.permissionWaiters.size > 0) this.turn?.abort.abort();
  }

  private wake(): void {
    const w = this.inputWaiter;
    this.inputWaiter = null;
    w?.();
  }

  private handleControl(msg: Record<string, unknown>): void {
    const requestId = String(msg.request_id ?? "");
    const req = (msg.request ?? {}) as Record<string, unknown>;
    const ok = (response: Record<string, unknown>) => this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    switch (req.subtype) {
      case "initialize":
        ok({ commands: [], output_style: "default", available_output_styles: ["default"], models: [], account: { subscriptionType: "max" } });
        return;
      case "interrupt":
        ok({ still_queued: [] });
        this.turn?.abort.abort();
        return;
      case "set_permission_mode":
        this.mode = String(req.mode ?? this.mode);
        ok({});
        return;
      case "set_model":
        ok({});
        return;
      default:
        this.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `Unsupported control request subtype: ${String(req.subtype)}` } });
    }
  }

  private async nextInput(): Promise<string | null> {
    while (this.queue.length === 0 && !this.stdinClosed) {
      await new Promise<void>((r) => {
        this.inputWaiter = r;
      });
    }
    return this.queue.shift() ?? null;
  }

  // ───────────── 走らせる ─────────────

  async run(prompt: string | null): Promise<void> {
    if (this.args.inputFormat === "stream-json") {
      for (;;) {
        const input = await this.nextInput();
        if (input === null) break;
        await this.runTurn(input);
      }
      return;
    }
    await this.runTurn(prompt ?? "");
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Interrupted());
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Interrupted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private tools(): string[] {
    const base = this.args.tools ?? DEFAULT_TOOLS;
    const deniedNames = new Set(this.args.disallowedTools.filter((t) => !t.includes("(")));
    const list = base.filter((t) => t !== "" && !deniedNames.has(t));
    if (this.args.jsonSchema) list.push(STRUCTURED_OUTPUT_TOOL);
    return list;
  }

  private plugins(): { plugins: { name: string; path: string; source: string }[]; skills: string[] } {
    const plugins: { name: string; path: string; source: string }[] = [];
    const skills = [...BUILTIN_SKILLS];
    for (const dir of this.args.pluginDirs) {
      const abs = path.resolve(this.cwd, dir);
      let name = path.basename(abs);
      try {
        const manifest = JSON.parse(readFileSync(path.join(abs, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string") name = manifest.name;
      } catch {
        // plugin.json が無ければフォルダ名
      }
      plugins.push({ name, path: abs, source: `${name}@inline` });
      const skillsDir = path.join(abs, "skills");
      if (existsSync(skillsDir)) {
        for (const s of readdirSync(skillsDir).sort()) if (existsSync(path.join(skillsDir, s, "SKILL.md"))) skills.push(`${name}:${s}`);
      }
    }
    return { plugins, skills };
  }

  private mcpServers(markers: Set<string>): { name: string; status: string }[] {
    if (markers.has("mcpleak")) return [{ name: "claude.ai Gmail", status: "connected" }];
    const out: { name: string; status: string }[] = [];
    for (const cfg of this.args.mcpConfigs) {
      try {
        const text = cfg.trim().startsWith("{") ? cfg : readFileSync(path.resolve(this.cwd, cfg), "utf8");
        const servers = (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
        for (const name of Object.keys(servers)) out.push({ name, status: "connected" });
      } catch {
        // 読めない設定は無視
      }
    }
    // --strict-mcp-config が無いと claude.ai のコネクタが残る（1.5）
    if (!this.args.strictMcpConfig) out.push({ name: "claude.ai Gmail", status: "needs-auth" });
    return out;
  }

  private emitInit(markers: Set<string>): void {
    const { plugins, skills } = this.plugins();
    this.write({
      type: "system",
      subtype: "init",
      cwd: this.cwd,
      session_id: this.session.sessionId,
      tools: this.tools(),
      mcp_servers: this.mcpServers(markers),
      model: this.model,
      permissionMode: this.mode,
      slash_commands: [...skills],
      apiKeySource: markers.has("apikey") ? "ANTHROPIC_API_KEY" : "none",
      claude_code_version: FAKE_VERSION,
      output_style: "default",
      agents: [],
      skills,
      plugins,
      uuid: randomUUID(),
    });
  }

  private afterAssistant(): void {
    if (!this.rateLimitPending) return;
    this.rateLimitPending = false;
    const now = Math.floor(Date.now() / 1000);
    const fiveHour = this.warn ? Math.max(0.85, num(this.env.FAKE_FIVE_HOUR_UTIL, 0.2)) : num(this.env.FAKE_FIVE_HOUR_UTIL, 0.2);
    const sevenDay = num(this.env.FAKE_SEVEN_DAY_UTIL, 0.1);
    const warning = this.warn || fiveHour >= 0.8 || sevenDay >= 0.9;
    this.write(
      rateLimitLine(this.session.sessionId, {
        status: warning ? "allowed_warning" : "allowed",
        fiveHour,
        sevenDay,
        fiveHourResetsAt: now + 3 * 3600,
        sevenDayResetsAt: now + 4 * 86400,
      }),
    );
  }

  /** 文章（--include-partial-messages なら 10 文字ずつ stream_event も） */
  private async emitText(text: string, signal: AbortSignal, deltaMs: number): Promise<void> {
    const id = messageId();
    const sid = this.session.sessionId;
    let sent = "";
    if (this.partial) {
      this.write(streamEvent(sid, id, messageStart(this.model, id)));
      this.write(streamEvent(sid, id, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      try {
        for (let i = 0; i < text.length; i += 10) {
          await this.pause(deltaMs, signal);
          const chunk = text.slice(i, i + 10);
          this.write(streamEvent(sid, id, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }));
          sent += chunk;
        }
      } catch (e) {
        // 途中で止められた: そこまでの文章を assistant として出す（実物）
        if (sent) this.write(assistantLine(sid, this.model, id, { type: "text", text: sent }));
        throw e;
      }
    }
    this.write(assistantLine(sid, this.model, id, { type: "text", text }));
    if (this.partial) {
      this.write(streamEvent(sid, id, { type: "content_block_stop", index: 0 }));
      this.write(streamEvent(sid, id, messageDelta("end_turn")));
      this.write(streamEvent(sid, id, { type: "message_stop" }));
    }
    this.afterAssistant();
  }

  private emitThinking(text: string): void {
    const id = messageId();
    this.write(assistantLine(this.session.sessionId, this.model, id, { type: "thinking", thinking: text, signature: "fake-signature" }));
    this.afterAssistant();
  }

  private emitToolUse(id: string, name: string, input: Record<string, unknown>): void {
    const mid = messageId();
    const sid = this.session.sessionId;
    if (this.partial) {
      this.write(streamEvent(sid, mid, messageStart(this.model, mid)));
      this.write(streamEvent(sid, mid, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }));
      const json = JSON.stringify(input);
      const half = Math.ceil(json.length / 2);
      this.write(streamEvent(sid, mid, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } }));
      this.write(streamEvent(sid, mid, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, half) } }));
      this.write(streamEvent(sid, mid, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(half) } }));
    }
    this.write(assistantLine(sid, this.model, mid, { type: "tool_use", id, name, input, caller: { type: "direct" } }));
    if (this.partial) {
      this.write(streamEvent(sid, mid, { type: "content_block_stop", index: 0 }));
      this.write(streamEvent(sid, mid, messageDelta("tool_use")));
      this.write(streamEvent(sid, mid, { type: "message_stop" }));
    }
    this.afterAssistant();
  }

  private waitPermission(requestId: string, signal: AbortSignal): Promise<PermissionReply> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Interrupted());
      const onAbort = () => {
        this.permissionWaiters.delete(requestId);
        reject(new Interrupted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.permissionWaiters.set(requestId, (r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      });
      if (this.stdinClosed) onAbort();
    });
  }

  private denyMessage(name: string, input: Record<string, unknown>): string {
    if (name === "Bash") return `Permission to use Bash with command ${String(input.command ?? "")} has been denied.`;
    return `Permission to use ${name} has been denied.`;
  }

  /** 道具の 1 手: 呼び出し → 判定（拒否・承認・許可）→ 実行 → 結果 */
  private async runToolStep(
    step: Extract<Step, { kind: "tool" }>,
    signal: AbortSignal,
    denials: { tool_name: string; tool_use_id: string; tool_input: unknown }[],
  ): Promise<StepResult> {
    const id = toolUseId();
    const sid = this.session.sessionId;
    let input = step.input;
    this.emitToolUse(id, step.name, input);
    const resultLine = (content: string, isError: boolean, tur: unknown): StepResult => {
      this.write(userToolResultLine(sid, id, content, isError, tur));
      return { ok: !isError, denied: false, content, toolUseResult: tur };
    };
    const denied = (message: string, systemLine: boolean, reason: string): StepResult => {
      if (systemLine) this.write({ type: "system", subtype: "permission_denied", tool_name: step.name, tool_use_id: id, decision_reason_type: reason, message, uuid: randomUUID(), session_id: sid });
      denials.push({ tool_name: step.name, tool_use_id: id, tool_input: input });
      this.write(userToolResultLine(sid, id, message, true, `Error: ${message}`));
      return { ok: false, denied: true, content: message, toolUseResult: `Error: ${message}` };
    };

    if (!this.tools().includes(step.name)) {
      const message = `No such tool available: ${step.name}`;
      return resultLine(`<tool_use_error>Error: ${message}</tool_use_error>`, true, `Error: ${message}`);
    }
    const verdict = evaluatePermission(
      { cwd: this.cwd, addDirs: this.args.addDirs, allow: this.args.allowedTools.map(parseRule), deny: this.args.disallowedTools.map(parseRule), mode: this.mode },
      step.name,
      input,
    );
    if (verdict.kind === "deny") return denied(this.denyMessage(step.name, input), true, "rule");
    if (verdict.kind === "ask") {
      // dontAsk は許可ルールに無いものを聞かずに拒否する（1.2）。聞けるのは --permission-prompt-tool stdio のときだけ
      if (this.mode === "dontAsk") return denied(this.denyMessage(step.name, input), true, "mode");
      if (this.args.permissionPromptTool !== "stdio") return denied(this.denyMessage(step.name, input), true, "asyncAgent");
      const requestId = randomUUID();
      const target = String(input.file_path ?? input.notebook_path ?? "");
      this.write({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: step.name,
          display_name: step.name,
          input,
          description: typeof input.description === "string" ? input.description : step.name,
          permission_suggestions:
            step.name === "Bash"
              ? [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: String(input.command ?? "") }], behavior: "allow", destination: "localSettings" }]
              : [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
          ...(target ? { blocked_path: path.resolve(this.cwd, target) } : {}),
          tool_use_id: id,
        },
      });
      const reply = await this.waitPermission(requestId, signal);
      const r = (reply as { response?: Record<string, unknown> }).response ?? {};
      if (reply.subtype === "success" && r.behavior === "allow") {
        if (typeof r.updatedInput === "object" && r.updatedInput !== null) input = r.updatedInput as Record<string, unknown>;
      } else {
        const message = typeof r.message === "string" ? r.message : (reply as { error?: string }).error ?? "Permission denied";
        const res = denied(message, false, "user");
        if (r.interrupt === true) throw new Interrupted();
        return res;
      }
    }
    const out = runTool(step.name, input, {
      cwd: this.cwd,
      todos: this.session.todos,
      setTodos: (t) => {
        this.session.todos = t;
      },
      env: this.env,
    });
    return resultLine(out.content, out.isError, out.toolUseResult);
  }

  private emitStructuredOutput(value: unknown): void {
    const id = toolUseId();
    this.emitToolUse(id, STRUCTURED_OUTPUT_TOOL, value as Record<string, unknown>);
    this.write(userToolResultLine(this.session.sessionId, id, "Structured output provided successfully", false, "Structured output provided successfully"));
  }

  private result(fields: {
    subtype: string;
    isError: boolean;
    numTurns: number;
    started: number;
    text?: string;
    structured?: unknown;
    denials: unknown[];
    terminalReason: string | null;
    errors?: string[];
  }): void {
    const cost = Math.round(fields.numTurns * 0.0012 * 1e6) / 1e6;
    const line: Record<string, unknown> = {
      type: "result",
      subtype: fields.subtype,
      is_error: fields.isError,
      duration_ms: Date.now() - fields.started,
      duration_api_ms: Date.now() - fields.started,
      num_turns: fields.numTurns,
      ...(fields.text !== undefined ? { result: fields.text } : {}),
      stop_reason: fields.isError ? null : fields.structured !== undefined ? "tool_use" : "end_turn",
      session_id: this.session.sessionId,
      total_cost_usd: cost,
      usage: usage(20 * fields.numTurns),
      modelUsage: { [this.model]: { inputTokens: 2, outputTokens: 20 * fields.numTurns, costUSD: cost } },
      permission_denials: fields.denials,
      ...(fields.structured !== undefined ? { structured_output: fields.structured } : {}),
      terminal_reason: fields.terminalReason,
      ...(fields.errors ? { errors: fields.errors } : {}),
      uuid: randomUUID(),
    };
    this.lastResultError = fields.isError;
    this.lastResult = line;
    this.write(line);
  }

  /** 枠切れ（[quota]、または他のプロセスで枠切れになって戻る前） */
  private quotaRejected(ctx: TurnContext, started: number): boolean {
    const now = Date.now();
    let g = loadGlobal(this.env);
    let blocked = g.quotaBlockedUntil !== null && now < g.quotaBlockedUntil;
    if (!blocked && ctx.markers.has("quota") && takeOnce("quota", onceKey(ctx), this.env)) {
      const resetSec = num(this.env.FAKE_QUOTA_RESET_SEC, 60);
      g = updateGlobal((x) => {
        x.quotaBlockedUntil = now + resetSec * 1000;
        x.quotaResetsAtSec = Math.ceil((now + resetSec * 1000) / 1000);
      }, this.env);
      blocked = true;
    }
    if (!blocked) return false;
    const resetsAt = g.quotaResetsAtSec ?? Math.ceil(now / 1000) + 60;
    this.rateLimitPending = false;
    this.write(
      rateLimitLine(this.session.sessionId, {
        status: "rejected",
        fiveHour: 1,
        sevenDay: num(this.env.FAKE_SEVEN_DAY_UTIL, 0.1),
        fiveHourResetsAt: resetsAt,
        sevenDayResetsAt: Math.floor(now / 1000) + 4 * 86400,
      }),
    );
    const text = `You've hit your session limit · resets ${clockText(resetsAt)}`;
    this.write(assistantLine(this.session.sessionId, "<synthetic>", messageId(), { type: "text", text }));
    this.result({ subtype: "success", isError: true, numTurns: 1, started, text, denials: [], terminalReason: "completed" });
    return true;
  }

  async runTurn(input: string): Promise<void> {
    const started = Date.now();
    const abort = new AbortController();
    this.turn = { abort };
    const s = this.session;
    const role: Role | null = detectRole(this.args.appendSystemPrompt ?? this.args.systemPrompt, this.args.jsonSchema);
    s.role = role;
    const markers = parseMarkers(input, role);
    for (const m of s.markers) markers.add(m);
    for (const m of markers) if (STICKY_MARKERS.has(m) && !s.markers.includes(m)) s.markers.push(m);
    const ctx: TurnContext = { role, input, lines: parseTurnInput(input), markers, session: s, cwd: this.cwd, schema: this.args.jsonSchema, env: this.env };
    this.warn = markers.has("warn");
    if (this.warn) this.rateLimitPending = true;
    const slow = markers.has("slow");
    const stepMs = slow ? this.slowMs : this.stepMs;
    const deltaMs = slow ? this.slowDeltaMs : this.deltaMs;
    const denials: { tool_name: string; tool_use_id: string; tool_input: unknown }[] = [];
    let numTurns = 1;
    let toolCalls = 0;
    let lastText: string | undefined;
    let structured: unknown;
    let outcome = "success";

    this.emitInit(markers);
    try {
      if (this.quotaRejected(ctx, started)) {
        outcome = "quota";
        return;
      }
      if (markers.has("fail") || (markers.has("fail-once") && takeOnce("fail", onceKey(ctx), this.env))) {
        await this.pause(stepMs, abort.signal);
        this.write({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 500, error: "server_error", uuid: randomUUID(), session_id: s.sessionId });
        this.result({
          subtype: "error_during_execution",
          isError: true,
          numTurns,
          started,
          denials,
          terminalReason: "api_error",
          errors: ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error（偽 claude の [fail]）"}}'],
        });
        outcome = "fail";
        return;
      }
      const forcedMaxTurns = markers.has("maxturns") || (markers.has("maxturns-once") && takeOnce("maxturns", onceKey(ctx), this.env));
      const maxTurns = forcedMaxTurns ? 1 : this.args.maxTurns;
      const badJson = markers.has("badjson") || (markers.has("badjson-once") && takeOnce("badjson", onceKey(ctx), this.env));

      const script = scriptFor(ctx);
      const prefix: Step[] = [];
      if (forcedMaxTurns) prefix.push({ kind: "tool", name: "Glob", input: { pattern: "**/*" } }, { kind: "tool", name: "Glob", input: { pattern: "**/*.md" } });
      if (markers.has("long")) {
        // --max-turns を超えない数にする（COO は 20。台本の道具の分を残す）
        const n = Math.max(1, Math.min(num(this.env.FAKE_CLAUDE_LONG_STEPS, 60), (maxTurns ?? 1000) - 6));
        for (let i = 0; i < n; i++) prefix.push(i % 2 === 0 ? { kind: "tool", name: "Glob", input: { pattern: `**/*${i}*` } } : { kind: "tool", name: "Grep", input: { pattern: `item${i}`, output_mode: "content" } });
      }
      let res: StepResult = null;
      let prefixIndex = 0;
      for (;;) {
        await this.pause(stepMs, abort.signal);
        while (this.followUps.length > 0) {
          const f = this.followUps.shift()!;
          const lines = parseTurnInput(f);
          const body = lines.length ? lines.map((l) => l.text).join(" / ") : f;
          const text = `追加の依頼を受けました: ${body}`;
          await this.emitText(text, abort.signal, deltaMs);
          lastText = text;
          numTurns += 1;
        }
        let step: Step;
        if (prefixIndex < prefix.length) step = prefix[prefixIndex++]!;
        else {
          const next = script.next(res);
          if (next.done) break;
          step = next.value;
        }
        if (maxTurns !== null && toolCalls >= maxTurns) {
          this.result({
            subtype: "error_max_turns",
            isError: true,
            numTurns: numTurns,
            started,
            denials,
            terminalReason: "max_turns",
            errors: [`Reached maximum number of turns (${maxTurns})`],
          });
          outcome = "max_turns";
          return;
        }
        res = null;
        switch (step.kind) {
          case "text":
            await this.emitText(step.text, abort.signal, deltaMs);
            lastText = step.text;
            break;
          case "thinking":
            this.emitThinking(step.text);
            break;
          case "sleep":
            await this.pause(step.ms, abort.signal);
            break;
          case "output":
            if (!this.args.jsonSchema) break;
            structured = badJson ? { reply: 42, note: "[badjson] スキーマに合わない値" } : step.value;
            this.emitStructuredOutput(structured);
            break;
          case "tool":
            res = await this.runToolStep(step, abort.signal, denials);
            toolCalls += 1;
            numTurns += 1;
            break;
        }
      }
      if (this.args.jsonSchema && structured === undefined) {
        structured = badJson ? { reply: 42 } : sampleFromSchema(this.args.jsonSchema);
        this.emitStructuredOutput(structured);
      }
      this.result({
        subtype: "success",
        isError: false,
        numTurns,
        started,
        text: structured !== undefined ? JSON.stringify(structured) : (lastText ?? ""),
        structured,
        denials,
        terminalReason: "completed",
      });
    } catch (e) {
      if (!(e instanceof Interrupted)) throw e;
      outcome = "interrupted";
      this.write(userTextLine(s.sessionId, INTERRUPTED_USER_TEXT));
      this.result({
        subtype: "error_during_execution",
        isError: true,
        numTurns,
        started,
        denials: [],
        terminalReason: "aborted_streaming",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      });
    } finally {
      this.turn = null;
      // ターン中に来て使わなかった追加の入力は次のターンへ
      if (this.followUps.length > 0) {
        this.queue.push(...this.followUps);
        this.followUps = [];
      }
      s.turns.push({ input: input.slice(0, 4000), at: started, outcome });
      saveSession(s, this.env);
    }
  }
}
