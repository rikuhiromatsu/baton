// 秘書 bot の入口（DESIGN-v2 11 章）を E2E から叩く道具。MCP は状態なしの JSON-RPC 2.0（1 回の POST に 1 回の JSON 応答。11.2）
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { API_PATHS, MCP_PROTOCOL_VERSION, type McpToolDescriptor, type McpToolResult } from "@baton/shared";

export type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

let nextId = 1;

/** Authorization: Bearer <token> で /mcp に 1 回送る。Cookie は送らない（bot の API は Cookie を見ない。11.3） */
export async function mcpRaw(
  request: APIRequestContext,
  token: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<APIResponse> {
  return request.post(API_PATHS.mcp, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    data: body,
  });
}

export async function mcp<T = unknown>(request: APIRequestContext, token: string, method: string, params?: unknown): Promise<JsonRpcResponse<T>> {
  const res = await mcpRaw(request, token, { jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  if (res.status() !== 200) throw new Error(`/mcp ${method} が ${res.status()}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as JsonRpcResponse<T>;
}

export async function mcpInitialize(request: APIRequestContext, token: string) {
  return mcp<{ protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown> }>(
    request,
    token,
    "initialize",
    { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "baton-e2e", version: "1" } },
  );
}

export async function mcpToolsList(request: APIRequestContext, token: string): Promise<McpToolDescriptor[]> {
  const res = await mcp<{ tools: McpToolDescriptor[] }>(request, token, "tools/list", {});
  if (res.error) throw new Error(`tools/list がエラー: ${res.error.message}`);
  return res.result?.tools ?? [];
}

export async function mcpCallTool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown> = {}) {
  return mcp<McpToolResult>(request, token, "tools/call", { name, arguments: args });
}
