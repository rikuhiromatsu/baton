// Claude Code の stream-json（`claude -p --output-format stream-json --verbose`）の行の型と、
// 制御プロトコル（--input-format stream-json・--permission-prompt-tool stdio）の型（DESIGN-v2 1.2・7.6）。
// 実物の記録: packages/shared/test/fixtures/claude/*.jsonl（scripts/claude-probe.mjs、claude 2.1.303）。
// 版で項目が増えるので、すべて寛容に読む（知らない項目は残す。知らない type は "unknown" として扱う）。
import { z } from "zod";

// ───────────── claude → ランナー（stdout） ─────────────

const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

export const TextBlock = loose({ type: z.literal("text"), text: z.string() });
export const ThinkingBlock = loose({ type: z.literal("thinking"), thinking: z.string().optional().default("") });
export const ToolUseBlock = loose({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() });
export const ToolResultBlock = loose({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});
const OtherBlock = loose({ type: z.string() });

export const AssistantContentBlock = z.union([TextBlock, ThinkingBlock, ToolUseBlock, OtherBlock]);
export const UserContentBlock = z.union([ToolResultBlock, TextBlock, OtherBlock]);

export const SystemInit = loose({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).optional().default([]),
  mcp_servers: z.array(loose({ name: z.string().optional(), status: z.string().optional() })).optional().default([]),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  apiKeySource: z.string().optional(),
  claude_code_version: z.string().optional(),
  skills: z.array(z.string()).optional().default([]),
  plugins: z.array(loose({ name: z.string(), path: z.string().optional(), source: z.string().optional() })).optional().default([]),
});
export type SystemInit = z.infer<typeof SystemInit>;

export const SystemPermissionDenied = loose({
  type: z.literal("system"),
  subtype: z.literal("permission_denied"),
  tool_name: z.string(),
  tool_use_id: z.string().optional(),
  message: z.string().optional(),
  decision_reason_type: z.string().optional(),
});

export const SystemApiRetry = loose({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number().optional(),
  max_retries: z.number().optional(),
  retry_delay_ms: z.number().optional(),
  error_status: z.number().nullable().optional(),
  error: z.unknown().optional(),
});

/** status・thinking_tokens・task_summary・post_turn_summary・commands_changed など */
export const SystemOther = loose({ type: z.literal("system"), subtype: z.string() });

export const AssistantMessage = loose({
  type: z.literal("assistant"),
  message: loose({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(AssistantContentBlock),
    usage: z.unknown().optional(),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const UserMessage = loose({
  type: z.literal("user"),
  message: loose({ role: z.literal("user").optional(), content: z.union([z.string(), z.array(UserContentBlock)]) }),
  parent_tool_use_id: z.string().nullable().optional(),
  /** 道具の構造化した結果（Edit・Write の structuredPatch、Bash の stdout/stderr、TodoWrite の newTodos など） */
  tool_use_result: z.unknown().optional(),
  session_id: z.string().optional(),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const RESULT_SUBTYPES = [
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
] as const;

export const ResultMessage = loose({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional().default(false),
  num_turns: z.number().optional().default(0),
  duration_ms: z.number().optional().default(0),
  total_cost_usd: z.number().optional().default(0),
  result: z.string().optional(),
  session_id: z.string().optional(),
  usage: loose({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }).optional(),
  permission_denials: z
    .array(loose({ tool_name: z.string(), tool_use_id: z.string().optional(), tool_input: z.unknown().optional() }))
    .optional()
    .default([]),
  structured_output: z.unknown().optional(),
  terminal_reason: z.string().nullable().optional(),
});
export type ResultMessage = z.infer<typeof ResultMessage>;

/** --include-partial-messages の行。event は Messages API のストリームのイベント */
export const StreamEvent = loose({
  type: z.literal("stream_event"),
  event: loose({
    type: z.string(),
    index: z.number().optional(),
    delta: loose({ type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(), partial_json: z.string().optional() }).optional(),
    content_block: loose({ type: z.string(), id: z.string().optional(), name: z.string().optional() }).optional(),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
});
export type StreamEvent = z.infer<typeof StreamEvent>;

const UnifiedWindow = loose({ utilization: z.number().nullable().optional(), resetsAt: z.number().nullable().optional() });

export const RateLimitEvent = loose({
  type: z.literal("rate_limit_event"),
  rate_limit_info: loose({
    status: z.string(),
    resetsAt: z.number().nullable().optional(),
    rateLimitType: z.string().nullable().optional(),
    utilization: z.number().nullable().optional(),
    overageStatus: z.string().nullable().optional(),
    /** 型定義に無いが実物にある（1.4）。あれば使う */
    unifiedWindows: z.record(z.string(), UnifiedWindow).optional(),
  }),
});
export type RateLimitEvent = z.infer<typeof RateLimitEvent>;

/** claude → ランナーの制御要求（承認など） */
export const CanUseToolRequest = loose({
  subtype: z.literal("can_use_tool"),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
  permission_suggestions: z.array(z.unknown()).optional(),
});
export const IncomingControlRequest = loose({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.union([CanUseToolRequest, loose({ subtype: z.string() })]),
});
export type IncomingControlRequest = z.infer<typeof IncomingControlRequest>;

/** ランナーの制御要求（initialize・interrupt など）への応答 */
export const IncomingControlResponse = loose({
  type: z.literal("control_response"),
  response: loose({
    subtype: z.enum(["success", "error"]),
    request_id: z.string(),
    response: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  }),
});
export type IncomingControlResponse = z.infer<typeof IncomingControlResponse>;

export type ClaudeStreamMessage =
  | ({ kind: "init" } & { value: SystemInit })
  | { kind: "permission_denied"; value: z.infer<typeof SystemPermissionDenied> }
  | { kind: "api_retry"; value: z.infer<typeof SystemApiRetry> }
  | { kind: "system"; value: z.infer<typeof SystemOther> }
  | { kind: "assistant"; value: AssistantMessage }
  | { kind: "user"; value: UserMessage }
  | { kind: "result"; value: ResultMessage }
  | { kind: "stream_event"; value: StreamEvent }
  | { kind: "rate_limit"; value: RateLimitEvent }
  | { kind: "control_request"; value: IncomingControlRequest }
  | { kind: "control_response"; value: IncomingControlResponse }
  | { kind: "unknown"; value: unknown }
  | { kind: "invalid"; line: string; error: string };

/** 1 行を読む。JSON でなければ invalid、知っている type でも形が合わなければ unknown（生ログには残す） */
export function parseStreamLine(line: string): ClaudeStreamMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    return { kind: "invalid", line: line.slice(0, 500), error: e instanceof Error ? e.message : String(e) };
  }
  return classifyStreamValue(raw);
}

export function classifyStreamValue(raw: unknown): ClaudeStreamMessage {
  if (typeof raw !== "object" || raw === null) return { kind: "unknown", value: raw };
  const type = (raw as { type?: unknown }).type;
  const subtype = (raw as { subtype?: unknown }).subtype;
  const tryParse = <S extends z.ZodType>(s: S) => {
    const r = s.safeParse(raw);
    return r.success ? (r.data as z.infer<S>) : null;
  };
  switch (type) {
    case "system": {
      if (subtype === "init") {
        const v = tryParse(SystemInit);
        return v ? { kind: "init", value: v } : { kind: "unknown", value: raw };
      }
      if (subtype === "permission_denied") {
        const v = tryParse(SystemPermissionDenied);
        return v ? { kind: "permission_denied", value: v } : { kind: "unknown", value: raw };
      }
      if (subtype === "api_retry") {
        const v = tryParse(SystemApiRetry);
        return v ? { kind: "api_retry", value: v } : { kind: "unknown", value: raw };
      }
      const v = tryParse(SystemOther);
      return v ? { kind: "system", value: v } : { kind: "unknown", value: raw };
    }
    case "assistant": {
      const v = tryParse(AssistantMessage);
      return v ? { kind: "assistant", value: v } : { kind: "unknown", value: raw };
    }
    case "user": {
      const v = tryParse(UserMessage);
      return v ? { kind: "user", value: v } : { kind: "unknown", value: raw };
    }
    case "result": {
      const v = tryParse(ResultMessage);
      return v ? { kind: "result", value: v } : { kind: "unknown", value: raw };
    }
    case "stream_event": {
      const v = tryParse(StreamEvent);
      return v ? { kind: "stream_event", value: v } : { kind: "unknown", value: raw };
    }
    case "rate_limit_event": {
      const v = tryParse(RateLimitEvent);
      return v ? { kind: "rate_limit", value: v } : { kind: "unknown", value: raw };
    }
    case "control_request": {
      const v = tryParse(IncomingControlRequest);
      return v ? { kind: "control_request", value: v } : { kind: "unknown", value: raw };
    }
    case "control_response": {
      const v = tryParse(IncomingControlResponse);
      return v ? { kind: "control_response", value: v } : { kind: "unknown", value: raw };
    }
    default:
      return { kind: "unknown", value: raw };
  }
}

// ───────────── ランナー → claude（stdin、--input-format stream-json） ─────────────

/** 1 通の入力（1 ターンを回す。ターン中なら次の一手の前に読まれる） */
export type StdinUserMessage = { type: "user"; message: { role: "user"; content: string } };
export function userInput(text: string): StdinUserMessage {
  return { type: "user", message: { role: "user", content: text } };
}

export const OUTGOING_CONTROL_SUBTYPES = ["initialize", "interrupt", "set_permission_mode", "set_model"] as const;
export type OutgoingControlSubtype = (typeof OUTGOING_CONTROL_SUBTYPES)[number];

export type StdinControlRequest = {
  type: "control_request";
  request_id: string;
  request:
    | { subtype: "initialize" }
    | { subtype: "interrupt" }
    | { subtype: "set_permission_mode"; mode: string }
    | { subtype: "set_model"; model?: string };
};
export function controlRequest(requestId: string, request: StdinControlRequest["request"]): StdinControlRequest {
  return { type: "control_request", request_id: requestId, request };
}

/** can_use_tool への答え（allow なら updatedInput に元の input をそのまま。deny なら理由。実物で確認済み） */
export type PermissionAnswer =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };
export type StdinControlResponse = {
  type: "control_response";
  response: { subtype: "success"; request_id: string; response: PermissionAnswer } | { subtype: "error"; request_id: string; error: string };
};
export function permissionResponse(requestId: string, answer: PermissionAnswer): StdinControlResponse {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: answer } };
}

export type StdinMessage = StdinUserMessage | StdinControlRequest | StdinControlResponse;

/** stdin に書く 1 行 */
export function encodeStdin(msg: StdinMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

/** StructuredOutput の道具の名前（--json-schema のとき最後に呼ばれる） */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** 中断したときに claude が書く user の文（実物） */
export const INTERRUPTED_USER_TEXT = "[Request interrupted by user]";

/** 中断の文か（道具の承認の途中で中断すると「… for tool use」が付く。本番で確認） */
export function isInterruptedUserText(text: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim());
}

/** サブスクの枠切れの文（-p では result の本文。1.4） */
export const LIMIT_HIT_PATTERN = /You've hit your (session|weekly|[a-z ]+) limit/i;
