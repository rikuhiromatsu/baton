// stream-json の正規化（DESIGN-v2 8.3・8.4・4.7・9.1）。
// normalizeStreamLine(line, state) → { state, items, session?, quota?, control?, delta?, activity? }。純粋関数（state は新しいものを返す）。
// 項目（TranscriptDraft）の seq・id・時刻はランナーが付ける。道具の要約は日本語の固定動詞（D-59）。
import {
  INTERRUPTED_USER_TEXT,
  LIMIT_HIT_PATTERN,
  STRUCTURED_OUTPUT_TOOL,
  parseStreamLine,
  type ClaudeStreamMessage,
} from "./claude-stream.ts";
import { LIMITS } from "./limits.ts";
import type { QuotaStatus, TranscriptAuthor, TranscriptItemKind } from "./models.ts";

// ───────────── 形 ─────────────

export type TranscriptDraft = {
  kind: TranscriptItemKind;
  author: TranscriptAuthor;
  toolName: string | null;
  toolUseId: string | null;
  parentToolUseId: string | null;
  /** 1 行（200 文字まで） */
  summary: string;
  body: Record<string, unknown>;
  truncated: boolean;
  isError: boolean;
};

export type NormalizeState = {
  /** 相対パスの基準（init の cwd。無ければ起動時に渡したもの） */
  cwd: string | null;
  sessionId: string | null;
  /** tool_use_id → 道具の名前と入力（結果の要約に使う） */
  tools: Record<string, { name: string; input: Record<string, unknown> }>;
  /** 最後の道具の呼び出し（StructuredOutput を除く）より後の文章（返事の本文。4.7・D-76） */
  replyText: string;
  /** StructuredOutput の入力（result.structured_output が無いときの予備） */
  structuredOutput: unknown;
};

export function initialNormalizeState(cwd: string | null = null): NormalizeState {
  return { cwd, sessionId: null, tools: {}, replyText: "", structuredOutput: undefined };
}

export type SessionInitInfo = {
  kind: "init";
  sessionId: string;
  model: string | null;
  cwd: string | null;
  permissionMode: string | null;
  claudeCodeVersion: string | null;
  /** "none" 以外はサブスク以外の認証（7.7・D-48）。ランナーは即停止 */
  apiKeySource: string | null;
  /** 空でなければ --strict-mcp-config が効いていない（7.7）。ランナーは即停止 */
  mcpServers: string[];
  tools: string[];
  skills: string[];
  plugins: string[];
};

export type SessionResultInfo = {
  kind: "result";
  sessionId: string | null;
  subtype: string;
  isError: boolean;
  numTurns: number;
  durationMs: number;
  costUsdEst: number;
  terminalReason: string | null;
  structuredOutput: unknown;
  /** result の本文（-p の最後の文章。枠切れの文もここ） */
  resultText: string | null;
  /** 最後の道具の呼び出しより後の文章（返事の本文） */
  replyText: string;
  /** input + cache_creation（cache_read は含めない） */
  tokensIn: number;
  tokensOut: number;
  permissionDenials: { toolName: string; toolUseId: string | null }[];
  /** You've hit your … limit（9.2） */
  limitHit: boolean;
};

export type QuotaObservation = {
  status: "allowed" | "allowed_warning" | "rejected" | "unknown";
  rateLimitType: string | null;
  /** UNIX ミリ秒（stream-json は秒なので変換済み） */
  resetsAt: number | null;
  utilization: number | null;
  fiveHour: { utilization: number | null; resetsAt: number | null } | null;
  sevenDay: { utilization: number | null; resetsAt: number | null } | null;
};

export type ControlEvent =
  | {
      kind: "can_use_tool";
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolUseId: string | null;
      description: string | null;
    }
  | { kind: "request"; requestId: string; subtype: string }
  | { kind: "response"; requestId: string; subtype: "success" | "error"; response: Record<string, unknown> | null; error: string | null };

/** 4.7 のストリーミング。text は返事に継ぎ足す、reset はそれまでの文章を前置きとして会話から外す */
export type StreamDelta = { type: "text"; text: string } | { type: "reset" };

export type NormalizeResult = {
  state: NormalizeState;
  items: TranscriptDraft[];
  session?: SessionInitInfo | SessionResultInfo;
  quota?: QuotaObservation;
  control?: ControlEvent;
  delta?: StreamDelta;
  /** いまの動き（現在形の 1 行）。null は消す */
  activity?: string | null;
};

// ───────────── 文字列の道具 ─────────────

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 1 行目を max 文字まで */
export function firstLine(text: string, max: number = LIMITS.summaryPreviewChars): string {
  const line = text.replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim() !== "") ?? "";
  return clip(line.trim(), max);
}

/** 先頭 head 文字＋末尾 tail 文字 */
export function headTail(text: string, head: number, tail: number): { text: string; truncated: boolean } {
  if (text.length <= head + tail) return { text, truncated: false };
  return { text: `${text.slice(0, head)}\n…（${text.length - head - tail} 文字省略）…\n${text.slice(text.length - tail)}`, truncated: true };
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/** cwd からの相対パス（外なら絶対パスのまま） */
export function relPath(path: string, cwd: string | null): string {
  if (!cwd) return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return ".";
  return path.startsWith(base) ? path.slice(base.length) : path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 60);
  }
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");

// ───────────── 道具の要約（D-59） ─────────────

export const TOOL_VERBS = {
  Read: { past: "読んだ", present: "読んでいる" },
  Grep: { past: "検索した", present: "検索している" },
  Glob: { past: "検索した", present: "検索している" },
  Edit: { past: "編集した", present: "編集している" },
  NotebookEdit: { past: "編集した", present: "編集している" },
  Write: { past: "作成した", present: "書いている" },
  Bash: { past: "実行した", present: "実行している" },
  WebFetch: { past: "取得した", present: "取得している" },
  WebSearch: { past: "調べた", present: "調べている" },
  Skill: { past: "使った", present: "使っている" },
} as const;
export const WRITE_UPDATE_VERB = "書き換えた";
export const TODO_UPDATED = "TODO を更新";
export const THINKING_ACTIVITY = "考えている";
export const REPLYING_ACTIVITY = "返事を書いている";

/** 道具の対象（パス・パターン・コマンドなど） */
function toolTarget(name: string, input: Record<string, unknown>, cwd: string | null): string {
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return relPath(s(input.file_path), cwd);
    case "NotebookEdit":
      return relPath(s(input.notebook_path), cwd);
    case "Grep":
    case "Glob":
      return s(input.pattern);
    case "Bash":
      return clip(s(input.command).replace(/\s+/g, " ").trim(), 60);
    case "WebFetch":
      return hostOf(s(input.url));
    case "WebSearch":
      return s(input.query);
    case "Skill":
      return s(input.skill) || s(input.command) || s(input.name);
    default:
      return "";
  }
}

/** 過去形の要約（トランスクリプトの 1 行） */
export function toolSummary(name: string, input: Record<string, unknown>, cwd: string | null): string {
  if (name === "TodoWrite") return TODO_UPDATED;
  const verbs = TOOL_VERBS[name as keyof typeof TOOL_VERBS];
  if (!verbs) return clip(name, LIMITS.summaryMaxChars);
  const target = toolTarget(name, input, cwd);
  return clip(target ? `${verbs.past} ${target}` : verbs.past, LIMITS.summaryMaxChars);
}

/** 現在形（いまの動き）。Grep・Glob は対象を出さない（8.3 の表） */
export function toolActivity(name: string, input: Record<string, unknown>, cwd: string | null): string | null {
  if (name === "TodoWrite" || name === STRUCTURED_OUTPUT_TOOL) return null;
  const verbs = TOOL_VERBS[name as keyof typeof TOOL_VERBS];
  if (!verbs) return null;
  if (name === "Grep" || name === "Glob") return verbs.present;
  const target = name === "Bash" ? clip(s(input.command).replace(/\s+/g, " ").trim(), 60) : toolTarget(name, input, cwd);
  return clip(target ? `${verbs.present} ${target}` : verbs.present, LIMITS.summaryMaxChars);
}

// ───────────── 項目を作る ─────────────

function draft(partial: Partial<TranscriptDraft> & Pick<TranscriptDraft, "kind" | "author" | "summary" | "body">): TranscriptDraft {
  return {
    toolName: null,
    toolUseId: null,
    parentToolUseId: null,
    truncated: false,
    isError: false,
    ...partial,
    summary: clip(partial.summary, LIMITS.summaryMaxChars),
  };
}

/** ランナーが書いた入力（CEO の追加の依頼・上司からの依頼・ランナーの連絡） */
export function userInputItem(text: string, author: "ceo" | "runner"): TranscriptDraft {
  const body = cap(text, LIMITS.bodyTextMaxChars);
  return draft({ kind: "user", author, summary: firstLine(text), body: { text: body.text }, truncated: body.truncated });
}

/** 承認の依頼（can_use_tool を受けてランナーが decisions を作ったあと） */
export function approvalItem(input: {
  decisionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string | null;
  cwd: string | null;
}): TranscriptDraft {
  const target = toolTarget(input.toolName, input.toolInput, input.cwd);
  const json = JSON.stringify(input.toolInput);
  const capped = json.length > LIMITS.bodyToolInputMaxChars;
  return draft({
    kind: "approval",
    author: "system",
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    summary: `承認待ち: ${input.toolName}${target ? ` ${target}` : ""}`,
    body: { decisionId: input.decisionId, toolName: input.toolName, input: capped ? { truncated: json.slice(0, LIMITS.bodyToolInputMaxChars) } : input.toolInput },
    truncated: capped,
  });
}

/** ランナーの出来事（8.3 の最後の行） */
export const RUNNER_EVENT_LABELS = ["中断", "再開", "枠待ち", "コミット", "統合", "衝突", "Codex レビュー"] as const;
export type RunnerEventLabel = (typeof RUNNER_EVENT_LABELS)[number];
export function runnerEventItem(label: RunnerEventLabel, body: Record<string, unknown> = {}, detail?: string): TranscriptDraft {
  return draft({ kind: "system", author: "runner", summary: detail ? `${label} ${detail}` : label, body });
}

function toolInputBody(name: string, input: Record<string, unknown>): { body: Record<string, unknown>; truncated: boolean } {
  let truncated = false;
  let value: Record<string, unknown> = input;
  if (name === "Write" && typeof input.content === "string" && input.content.length > LIMITS.bodyWriteContentMaxChars) {
    value = { ...input, content: input.content.slice(0, LIMITS.bodyWriteContentMaxChars) };
    truncated = true;
  }
  const json = JSON.stringify(value);
  if (json.length > LIMITS.bodyToolInputMaxChars) {
    return { body: { input: { truncated: json.slice(0, LIMITS.bodyToolInputMaxChars) } }, truncated: true };
  }
  return { body: { input: value }, truncated };
}

/** tool_result の content（文字列か [{type:"text",text}]）を文字列に */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" ? s((c as { text?: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

type Hunk = { oldStart?: number; oldLines?: number; newStart?: number; newLines?: number; lines?: unknown };

/** structuredPatch → unified の行（400 行まで）と足し引きの数 */
export function patchLines(structuredPatch: unknown): { lines: string[]; added: number; removed: number; truncated: boolean } {
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  if (!Array.isArray(structuredPatch)) return { lines: out, added, removed, truncated: false };
  for (const h of structuredPatch as Hunk[]) {
    out.push(`@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`);
    for (const l of Array.isArray(h.lines) ? (h.lines as unknown[]) : []) {
      const line = s(l);
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
      out.push(line);
    }
  }
  const truncated = out.length > LIMITS.patchMaxLines;
  return { lines: truncated ? out.slice(0, LIMITS.patchMaxLines) : out, added, removed, truncated };
}

function toolResultItem(
  block: { tool_use_id: string; content?: unknown; is_error?: boolean },
  structured: unknown,
  parentToolUseId: string | null,
  state: NormalizeState,
): TranscriptDraft | null {
  const tool = state.tools[block.tool_use_id];
  const name = tool?.name ?? null;
  const isError = block.is_error === true;
  // StructuredOutput の受け取り確認と TodoWrite の定型文は項目にしない（失敗は残す）
  if (!isError && (name === STRUCTURED_OUTPUT_TOOL || name === "TodoWrite")) return null;
  const text = resultText(block.content);
  const base = { kind: "tool_result" as const, author: "claude" as const, toolName: name, toolUseId: block.tool_use_id, parentToolUseId, isError };
  const st = (typeof structured === "object" && structured !== null ? structured : {}) as Record<string, unknown>;

  if (!isError && (name === "Edit" || name === "Write" || name === "NotebookEdit")) {
    let p = patchLines(st.structuredPatch);
    // 新規作成の Write は structuredPatch が空で、content に全文がある（実物）
    if (p.lines.length === 0 && name === "Write" && typeof st.content === "string" && st.content !== "") {
      const body = st.content.replace(/\n$/, "").split("\n");
      p = patchLines([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: body.length, lines: body.map((l) => `+${l}`) }]);
    }
    const filePath = s(st.filePath) || s(tool?.input.file_path) || s(tool?.input.notebook_path);
    const type = name === "Write" ? (s(st.type) || "create") : "edit";
    const rel = relPath(filePath, state.cwd);
    const verb = name === "Write" ? (type === "update" ? WRITE_UPDATE_VERB : TOOL_VERBS.Write.past) : TOOL_VERBS.Edit.past;
    return draft({
      ...base,
      summary: `${verb} ${rel}（+${p.added} −${p.removed}）`,
      body: { filePath: rel, type, patch: p.lines.join("\n"), added: p.added, removed: p.removed },
      truncated: p.truncated,
    });
  }
  if (!isError && name === "Bash" && ("stdout" in st || "stderr" in st)) {
    const out = headTail(s(st.stdout), LIMITS.toolResultHeadChars, LIMITS.toolResultTailChars);
    const err = headTail(s(st.stderr), LIMITS.toolResultHeadChars, LIMITS.toolResultTailChars);
    return draft({
      ...base,
      summary: firstLine(s(st.stdout) || s(st.stderr) || text),
      body: { stdout: out.text, stderr: err.text },
      truncated: out.truncated || err.truncated,
    });
  }
  const ht = headTail(text, LIMITS.toolResultHeadChars, LIMITS.toolResultTailChars);
  const body: Record<string, unknown> = { text: ht.text };
  // 小さい構造化の結果だけ添える（Read の file.content などの大きいものは捨てる）
  if (structured !== undefined && typeof structured === "object" && structured !== null) {
    const json = JSON.stringify(structured);
    if (json.length <= 2_000) body.structured = structured;
  }
  return draft({ ...base, summary: firstLine(text), body, truncated: ht.truncated });
}

// ───────────── 本体 ─────────────

/** 1 行を正規化する */
export function normalizeStreamLine(line: string, state: NormalizeState): NormalizeResult {
  return normalizeStreamMessage(parseStreamLine(line), state);
}

export function normalizeStreamMessage(msg: ClaudeStreamMessage, prev: NormalizeState): NormalizeResult {
  const state: NormalizeState = { ...prev, tools: prev.tools };
  switch (msg.kind) {
    case "init": {
      const v = msg.value;
      state.sessionId = v.session_id;
      if (v.cwd) state.cwd = v.cwd;
      const mcpServers = v.mcp_servers.map((m) => m.name ?? "?");
      return {
        state,
        items: [
          draft({
            kind: "system",
            author: "system",
            summary: "開始",
            body: {
              model: v.model ?? null,
              cwd: v.cwd ?? null,
              permissionMode: v.permissionMode ?? null,
              claudeCodeVersion: v.claude_code_version ?? null,
              toolsCount: v.tools.length,
              skills: v.skills,
              mcpCount: mcpServers.length,
            },
          }),
        ],
        session: {
          kind: "init",
          sessionId: v.session_id,
          model: v.model ?? null,
          cwd: v.cwd ?? null,
          permissionMode: v.permissionMode ?? null,
          claudeCodeVersion: v.claude_code_version ?? null,
          apiKeySource: v.apiKeySource ?? null,
          mcpServers,
          tools: v.tools,
          skills: v.skills,
          plugins: v.plugins.map((p) => p.name),
        },
      };
    }
    case "assistant": {
      const parent = msg.value.parent_tool_use_id ?? null;
      const items: TranscriptDraft[] = [];
      let activity: string | null | undefined;
      const tools = { ...state.tools };
      for (const block of msg.value.message.content) {
        const b = block as { type: string; [k: string]: unknown };
        if (b.type === "text") {
          const text = s(b.text);
          if (!text.trim()) continue;
          const body = cap(text, LIMITS.bodyTextMaxChars);
          items.push(draft({ kind: "text", author: "claude", parentToolUseId: parent, summary: firstLine(text), body: { text: body.text }, truncated: body.truncated }));
          if (parent === null) state.replyText = state.replyText ? `${state.replyText}\n\n${text}` : text;
          activity = THINKING_ACTIVITY;
        } else if (b.type === "thinking") {
          const text = s(b.thinking);
          activity = THINKING_ACTIVITY;
          if (!text.trim()) continue;
          const body = cap(text, LIMITS.bodyThinkingMaxChars);
          items.push(draft({ kind: "thinking", author: "claude", parentToolUseId: parent, summary: "考え", body: { text: body.text }, truncated: body.truncated }));
        } else if (b.type === "tool_use") {
          const name = s(b.name);
          const id = s(b.id);
          const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
          tools[id] = { name, input };
          // 返事の本文は「最後の道具の呼び出し（StructuredOutput を除く）より後の文章」。StructuredOutput は必ず最後に来るので数えない
          if (parent === null && name !== STRUCTURED_OUTPUT_TOOL) state.replyText = "";
          if (name === STRUCTURED_OUTPUT_TOOL) {
            state.structuredOutput = input;
            items.push(draft({ kind: "output", author: "claude", toolName: name, toolUseId: id, parentToolUseId: parent, summary: "結論", body: { value: input } }));
            continue;
          }
          const tb = toolInputBody(name, input);
          items.push(
            draft({
              kind: "tool_use",
              author: "claude",
              toolName: name,
              toolUseId: id,
              parentToolUseId: parent,
              summary: toolSummary(name, input, state.cwd),
              body: tb.body,
              truncated: tb.truncated,
            }),
          );
          activity = toolActivity(name, input, state.cwd);
        }
      }
      state.tools = tools;
      return activity === undefined ? { state, items } : { state, items, activity };
    }
    case "user": {
      const v = msg.value;
      const parent = v.parent_tool_use_id ?? null;
      const content = v.message.content;
      if (typeof content === "string") {
        if (content.trim() === INTERRUPTED_USER_TEXT) return { state, items: [runnerEventItem("中断")], activity: null };
        return { state, items: [userInputItem(content, "runner")] };
      }
      const items: TranscriptDraft[] = [];
      for (const block of content) {
        const b = block as { type: string; [k: string]: unknown };
        if (b.type === "tool_result") {
          const it = toolResultItem(b as unknown as { tool_use_id: string; content?: unknown; is_error?: boolean }, v.tool_use_result, parent, state);
          if (it) items.push(it);
        } else if (b.type === "text") {
          const text = s(b.text);
          if (text.trim() === INTERRUPTED_USER_TEXT) items.push(runnerEventItem("中断"));
          else if (text.trim()) items.push(userInputItem(text, "runner"));
        }
      }
      return { state, items };
    }
    case "permission_denied": {
      const v = msg.value;
      const tool = v.tool_use_id ? state.tools[v.tool_use_id] : undefined;
      const target = tool ? toolTarget(tool.name, tool.input, state.cwd) : "";
      return {
        state,
        items: [
          draft({
            kind: "denied",
            author: "system",
            toolName: v.tool_name,
            toolUseId: v.tool_use_id ?? null,
            summary: `拒否: ${v.tool_name}${target ? ` ${target}` : ""}`,
            body: { toolName: v.tool_name, reason: v.message ?? null },
          }),
        ],
      };
    }
    case "api_retry": {
      const v = msg.value;
      return {
        state,
        items: [
          draft({
            kind: "system",
            author: "system",
            summary: "再試行",
            body: { attempt: v.attempt ?? null, error: v.error ?? null, errorStatus: v.error_status ?? null, retryDelayMs: v.retry_delay_ms ?? null },
          }),
        ],
      };
    }
    case "system":
      // task_summary・post_turn_summary・status・thinking_tokens など（生ログだけ）
      return { state, items: [] };
    case "stream_event": {
      const v = msg.value;
      if ((v.parent_tool_use_id ?? null) !== null) return { state, items: [] };
      const ev = v.event;
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        return { state, items: [], delta: { type: "text", text: ev.delta.text } };
      }
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && ev.content_block.name !== STRUCTURED_OUTPUT_TOOL) {
        return { state, items: [], delta: { type: "reset" } };
      }
      return { state, items: [] };
    }
    case "rate_limit": {
      const info = msg.value.rate_limit_info;
      const toMs = (sec: number | null | undefined) => (typeof sec === "number" ? sec * 1000 : null);
      const win = (w: { utilization?: number | null; resetsAt?: number | null } | undefined) =>
        w ? { utilization: w.utilization ?? null, resetsAt: toMs(w.resetsAt) } : null;
      const status = (["allowed", "allowed_warning", "rejected"] as const).find((x) => x === info.status) ?? "unknown";
      const quota: QuotaObservation = {
        status,
        rateLimitType: info.rateLimitType ?? null,
        resetsAt: toMs(info.resetsAt),
        utilization: info.utilization ?? null,
        fiveHour: win(info.unifiedWindows?.five_hour),
        sevenDay: win(info.unifiedWindows?.seven_day),
      };
      const items =
        status === "rejected"
          ? [draft({ kind: "system", author: "system", summary: "枠切れ", body: { rateLimitType: quota.rateLimitType, resetsAt: quota.resetsAt } })]
          : [];
      return { state, items, quota };
    }
    case "result": {
      const v = msg.value;
      const u = v.usage ?? {};
      const text = v.result ?? null;
      const structuredOutput = v.structured_output !== undefined ? v.structured_output : state.structuredOutput;
      const session: SessionResultInfo = {
        kind: "result",
        sessionId: v.session_id ?? state.sessionId,
        subtype: v.subtype,
        isError: v.is_error,
        numTurns: v.num_turns,
        durationMs: v.duration_ms,
        costUsdEst: v.total_cost_usd,
        terminalReason: v.terminal_reason ?? null,
        structuredOutput,
        resultText: text,
        replyText: state.replyText,
        tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0,
        permissionDenials: v.permission_denials.map((d) => ({ toolName: d.tool_name, toolUseId: d.tool_use_id ?? null })),
        limitHit: text !== null && LIMIT_HIT_PATTERN.test(text),
      };
      const item = draft({
        kind: "result",
        author: "system",
        summary: "終了",
        isError: v.is_error,
        body: {
          subtype: v.subtype,
          numTurns: v.num_turns,
          durationMs: v.duration_ms,
          costUsdEst: v.total_cost_usd,
          terminalReason: v.terminal_reason ?? null,
          permissionDenials: session.permissionDenials,
        },
      });
      // 次のターン（stream-json 入力で続くとき）のために返事の本文を空に戻す
      const next: NormalizeState = { ...state, replyText: "", structuredOutput: undefined };
      return { state: next, items: [item], session, activity: null };
    }
    case "control_request": {
      const v = msg.value;
      const req = v.request as { subtype: string; [k: string]: unknown };
      if (req.subtype === "can_use_tool") {
        const input = (typeof req.input === "object" && req.input !== null ? req.input : {}) as Record<string, unknown>;
        return {
          state,
          items: [],
          control: {
            kind: "can_use_tool",
            requestId: v.request_id,
            toolName: s(req.tool_name),
            input,
            toolUseId: s(req.tool_use_id) || null,
            description: s(req.description) || null,
          },
        };
      }
      return { state, items: [], control: { kind: "request", requestId: v.request_id, subtype: req.subtype } };
    }
    case "control_response": {
      const r = msg.value.response;
      return {
        state,
        items: [],
        control: { kind: "response", requestId: r.request_id, subtype: r.subtype, response: r.response ?? null, error: r.error ?? null },
      };
    }
    case "unknown":
    case "invalid":
      return { state, items: [] };
  }
}

/** 複数行をまとめて正規化する（テストと再生用） */
export function normalizeStreamLines(lines: readonly string[], cwd: string | null = null) {
  let state = initialNormalizeState(cwd);
  const items: TranscriptDraft[] = [];
  const sessions: (SessionInitInfo | SessionResultInfo)[] = [];
  const quotas: QuotaObservation[] = [];
  const controls: ControlEvent[] = [];
  const deltas: StreamDelta[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = normalizeStreamLine(line, state);
    state = r.state;
    items.push(...r.items);
    if (r.session) sessions.push(r.session);
    if (r.quota) quotas.push(r.quota);
    if (r.control) controls.push(r.control);
    if (r.delta) deltas.push(r.delta);
  }
  return { state, items, sessions, quotas, controls, deltas };
}

// ───────────── 量の上限（8.4） ─────────────

/** 1 セッションの項目が上限を超えたら tool_result・thinking の body を空にする */
export function applySessionBudget(item: TranscriptDraft, sessionItemCount: number): TranscriptDraft {
  if (sessionItemCount < LIMITS.itemsPerSession) return item;
  if (item.kind === "tool_result" || item.kind === "thinking") return { ...item, body: {}, truncated: true };
  return item;
}

/** 1 指示の項目が上限を超えたら text・output・result・approval だけ残す（false なら捨てる） */
export function keepUnderInstructionBudget(item: TranscriptDraft, instructionItemCount: number): boolean {
  if (instructionItemCount < LIMITS.itemsPerInstruction) return true;
  return item.kind === "text" || item.kind === "output" || item.kind === "result" || item.kind === "approval";
}

/** WebSocket で配るとき body の文字列を 2,000 文字に切る */
export function clipForBroadcast(body: Record<string, unknown>): { body: Record<string, unknown>; truncated: boolean } {
  const json = JSON.stringify(body);
  if (json.length <= LIMITS.broadcastMaxChars) return { body, truncated: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = typeof v === "string" ? v.slice(0, LIMITS.broadcastMaxChars) : JSON.stringify(v).length > LIMITS.broadcastMaxChars ? null : v;
  }
  return { body: out, truncated: true };
}

// ───────────── 枠（9 章） ─────────────

/** rate_limit_event・result の枠切れを QuotaStatus に重ねる（9.2 のしきい値と待機） */
export function applyQuotaObservation(prev: QuotaStatus, obs: QuotaObservation | { status: "rejected"; limitHit: true; resetsAt?: null }, now: number): QuotaStatus {
  if ("limitHit" in obs) {
    return { ...prev, observedAt: now, status: "rejected", blockedUntil: now + LIMITS.quotaFallbackWaitMs, paused: true };
  }
  const fiveHour =
    obs.fiveHour ?? (obs.rateLimitType === "five_hour" ? { utilization: obs.utilization ?? prev.fiveHour.utilization, resetsAt: obs.resetsAt } : prev.fiveHour);
  const sevenDay =
    obs.sevenDay ?? (obs.rateLimitType === "seven_day" ? { utilization: obs.utilization ?? prev.sevenDay.utilization, resetsAt: obs.resetsAt } : prev.sevenDay);
  const rejected = obs.status === "rejected";
  const blockedUntil = rejected ? (obs.resetsAt !== null ? obs.resetsAt + LIMITS.quotaResumeMarginMs : now + LIMITS.quotaFallbackWaitMs) : null;
  return {
    observedAt: now,
    fiveHour,
    sevenDay,
    status: obs.status,
    rejectedType: rejected ? obs.rateLimitType : null,
    blockedUntil,
    paused: rejected || isOverThreshold({ fiveHour, sevenDay }),
  };
}

/** 5 時間枠 ≥ 0.80 か週の枠 ≥ 0.90（9.2） */
export function isOverThreshold(q: Pick<QuotaStatus, "fiveHour" | "sevenDay">): boolean {
  return (q.fiveHour.utilization ?? 0) >= LIMITS.quotaFiveHourPause || (q.sevenDay.utilization ?? 0) >= LIMITS.quotaSevenDayPause;
}

/** いまスレッドのターン（CEO の発言・承認・回答による再開など）を始めてよいか。枠切れの間だけ止める */
export function canStartThreadTurn(q: QuotaStatus, now: number): boolean {
  return q.blockedUntil === null || now >= q.blockedUntil;
}

/** いま新しいメンバーのセッションを起動してよいか（9.2。しきい値を超えている間も止める） */
export function canStartMemberSession(q: QuotaStatus, now: number): boolean {
  return canStartThreadTurn(q, now) && !isOverThreshold(q);
}
