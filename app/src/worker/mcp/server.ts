// 秘書 bot のリモート MCP サーバー（DESIGN-v2 11.2・D-90）。
// SDK を使わず、JSON-RPC 2.0 の initialize・notifications/initialized・tools/list・tools/call・ping だけを状態なしで処理する
// （Mcp-Session-Id を発行しない、SSE の継続ストリームは返さない。1 回の POST に 1 回の JSON 応答）。
import { Hono } from "hono";
import { MCP_ERRORS, MCP_PROTOCOL_VERSION, MCP_SERVER_INFO, mcpToolError, mcpToolList, mcpToolResult } from "@baton/shared";
import { botScopes, type BotTokenRow } from "../db/rows.ts";
import { callBotTool } from "../bot/handlers.ts";
import { findBotToken, touchBotToken } from "../middleware/bot-auth.ts";
import type { AppEnv } from "../types.ts";
import type { Env } from "../env.ts";

export const mcpRoutes = new Hono<AppEnv>();

type JsonRpcId = string | number | null;
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const INSTRUCTIONS =
  "Baton は CEO の AI チーム（COO・リーダー・メンバー）です。あなたは CEO の秘書として様子を読み、COO に連絡し、承認・判断に回答案を添えられます。決定はできません。まず baton_overview を呼んでください。";

const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

async function handleRpc(env: Env, token: BotTokenRow, msg: unknown): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, MCP_ERRORS.invalidRequest, "invalid request");
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = Object.hasOwn(m, "id");
  const id: JsonRpcId = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(id, MCP_ERRORS.invalidRequest, "invalid request");
  // 通知（id なし）には応答しない
  if (!hasId) return null;
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case "initialize": {
      // bot が別の版を求めたら、その版をそのまま返して同じ処理をする（11.2）
      const requested = typeof params.protocolVersion === "string" && params.protocolVersion ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO, instructions: INSTRUCTIONS },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: mcpToolList(botScopes(token)) } };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const r = await callBotTool(env, token, "mcp", name, params.arguments ?? {});
      if (r.ok) return { jsonrpc: "2.0", id, result: mcpToolResult(r.summary, r.data) };
      switch (r.kind) {
        case "unknown_tool":
          return rpcError(id, MCP_ERRORS.invalidParams, r.message);
        case "forbidden":
          return rpcError(id, MCP_ERRORS.forbidden, r.message);
        case "invalid":
          return rpcError(id, MCP_ERRORS.invalidParams, r.message, r.details);
        case "rate_limited":
          return rpcError(id, MCP_ERRORS.rateLimited, r.message, { retryAfter: r.retryAfterSec ?? 60 });
        default:
          // 見つからない・内部エラーは道具の実行エラーとして返す（bot が読めるように）
          return { jsonrpc: "2.0", id, result: mcpToolError(r.message) };
      }
    }
    default:
      return rpcError(id, MCP_ERRORS.methodNotFound, `method not found: ${m.method}`);
  }
}

mcpRoutes.post("/", async (c) => {
  const token = await findBotToken(c.env.DB, c.req.header("Authorization"));
  if (!token) {
    c.header("WWW-Authenticate", 'Bearer realm="baton"');
    return c.json(rpcError(null, -32001, "unauthorized"), 401);
  }
  await touchBotToken(c.env.DB, token.id, Date.now());
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json(rpcError(null, MCP_ERRORS.parseError, "parse error"), 400);
  }
  if (Array.isArray(body)) {
    const out: JsonRpcResponse[] = [];
    for (const item of body) {
      const r = await handleRpc(c.env, token, item);
      if (r) out.push(r);
    }
    if (out.length === 0) return c.body(null, 202);
    return c.json(out);
  }
  const r = await handleRpc(c.env, token, body);
  if (!r) return c.body(null, 202);
  c.header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  return c.json(r);
});

/** SSE の継続ストリームは返さない（状態なし） */
mcpRoutes.on(["GET", "DELETE"], "/", (c) => {
  c.header("Allow", "POST");
  return c.body(null, 405);
});
