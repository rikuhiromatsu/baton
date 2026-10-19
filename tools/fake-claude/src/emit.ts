// stream-json の行を作る（実物の記録 packages/shared/test/fixtures/claude/*.jsonl と同じ形）。
import { randomBytes, randomUUID } from "node:crypto";

export const FAKE_VERSION = "2.1.303";

const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5",
  default: "claude-sonnet-5-5",
};

export function resolveModel(model: string | null): string {
  if (!model) return MODEL_ALIASES.default!;
  return MODEL_ALIASES[model] ?? model;
}

export function toolUseId(): string {
  return `toolu_fake${randomBytes(10).toString("hex")}`;
}

export function messageId(): string {
  return `msg_fake${randomBytes(10).toString("hex")}`;
}

export function usage(output = 20) {
  return { input_tokens: 2, cache_creation_input_tokens: 120, cache_read_input_tokens: 4000, output_tokens: output, service_tier: "standard" };
}

export function assistantLine(sessionId: string, model: string, id: string, block: Record<string, unknown>, parent: string | null = null) {
  return {
    type: "assistant",
    message: { model, id, type: "message", role: "assistant", content: [block], stop_reason: null, stop_sequence: null, usage: usage() },
    parent_tool_use_id: parent,
    session_id: sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

export function userToolResultLine(sessionId: string, id: string, content: string, isError: boolean, toolUseResult: unknown) {
  return {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: isError }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    tool_use_result: toolUseResult,
  };
}

export function userTextLine(sessionId: string, text: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

export function streamEvent(sessionId: string, apiMessageId: string, event: Record<string, unknown>) {
  return { type: "stream_event", event, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), api_message_id: apiMessageId };
}

export function messageStart(model: string, id: string) {
  return { type: "message_start", message: { model, id, type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: usage(1) } };
}

/** message_delta の delta には type が無い（D-99） */
export function messageDelta(stopReason: "tool_use" | "end_turn") {
  return { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: usage() };
}

export function rateLimitLine(
  sessionId: string,
  info: { status: "allowed" | "allowed_warning" | "rejected"; fiveHour: number; sevenDay: number; fiveHourResetsAt: number; sevenDayResetsAt: number; rateLimitType?: string },
) {
  const type = info.rateLimitType ?? "five_hour";
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: info.status,
      resetsAt: type === "seven_day" ? info.sevenDayResetsAt : info.fiveHourResetsAt,
      rateLimitType: type,
      utilization: type === "seven_day" ? info.sevenDay : info.fiveHour,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: info.fiveHour, resetsAt: info.fiveHourResetsAt },
        seven_day: { utilization: info.sevenDay, resetsAt: info.sevenDayResetsAt },
      },
    },
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** 「3:45pm」の形（枠切れの文。1.4） */
export function clockText(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/** --json-schema の形から最小の値を作る（役割の台本が無いとき） */
export function sampleFromSchema(schema: unknown, root: Record<string, unknown> = schema as Record<string, unknown>, depth = 0): unknown {
  if (depth > 8 || typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    const ref = s.$ref.replace(/^#\//, "").split("/");
    let cur: unknown = root;
    for (const k of ref) cur = (cur as Record<string, unknown> | undefined)?.[k];
    return sampleFromSchema(cur, root, depth + 1);
  }
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  const variants = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const nonNull = variants.find((v) => (v as { type?: unknown }).type !== "null");
    if (variants.some((v) => (v as { type?: unknown }).type === "null")) return null;
    return sampleFromSchema(nonNull ?? variants[0], root, depth + 1);
  }
  const type = Array.isArray(s.type) ? (s.type.includes("null") ? "null" : s.type[0]) : s.type;
  switch (type) {
    case "null":
      return null;
    case "object": {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as string[]) : Object.keys(props);
      for (const k of required) out[k] = sampleFromSchema(props[k], root, depth + 1);
      return out;
    }
    case "array":
      return typeof s.minItems === "number" && s.minItems > 0 ? [sampleFromSchema(s.items, root, depth + 1)] : [];
    case "string":
      return typeof s.minLength === "number" && s.minLength > 4 ? "テスト".padEnd(s.minLength, "。") : "テスト";
    case "integer":
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}
