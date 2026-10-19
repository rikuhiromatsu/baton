// 秘書 bot の HTTP API（/api/bot/v1/*、DESIGN-v2 11.2・12.4）。MCP と同じ処理（handlers.ts）を呼ぶ薄い層。CORS のヘッダは返さない
import { Hono, type Context } from "hono";
import { botOpenApiDocument, type BotToolName } from "@baton/shared";
import { errorBody } from "../lib/errors.ts";
import { requireBot } from "../middleware/bot-auth.ts";
import type { AppEnv } from "../types.ts";
import { callBotTool } from "./handlers.ts";

export const botHttpRoutes = new Hono<AppEnv>();

botHttpRoutes.get("/openapi.json", (c) => c.json(botOpenApiDocument(c.env.APP_ORIGIN)));

botHttpRoutes.use("*", requireBot);

async function run(c: Context<AppEnv>, name: BotToolName, args: Record<string, unknown>) {
  const r = await callBotTool(c.env, c.get("botToken"), "http", name, args);
  if (r.ok) return c.json(r.data);
  switch (r.kind) {
    case "forbidden":
      return c.json(errorBody("forbidden", r.message), 403);
    case "invalid":
    case "unknown_tool":
      return c.json(errorBody("invalid", r.message, r.details), 400);
    case "not_found":
      return c.json(errorBody("not_found", r.message), 404);
    case "rate_limited":
      c.header("Retry-After", String(r.retryAfterSec ?? 60));
      return c.json(errorBody("rate_limited", r.message, { retryAfter: r.retryAfterSec ?? 60 }), 429);
    default:
      return c.json(errorBody("internal", r.message), 500);
  }
}

const int = (v: string | undefined) => (v === undefined || v === "" ? undefined : /^-?\d+$/.test(v) ? Number(v) : v);

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return { __invalid: true };
  }
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

botHttpRoutes.get("/overview", (c) => run(c, "baton_overview", {}));
botHttpRoutes.get("/projects", (c) => run(c, "baton_list_projects", clean({ status: c.req.query("status") })));
botHttpRoutes.get("/projects/:id", (c) => run(c, "baton_get_project", { projectId: c.req.param("id") }));
botHttpRoutes.get("/waiting", (c) => run(c, "baton_list_waiting", clean({ kind: c.req.query("kind") })));
botHttpRoutes.get("/instructions/:id", (c) => run(c, "baton_get_instruction", { instructionId: c.req.param("id") }));
botHttpRoutes.get("/coo-thread", (c) => run(c, "baton_read_coo_thread", clean({ limit: int(c.req.query("limit")), beforeSeq: int(c.req.query("beforeSeq")) })));
botHttpRoutes.post("/coo-thread/messages", async (c) => run(c, "baton_send_to_coo", await jsonBody(c)));
botHttpRoutes.post("/proposals", async (c) => run(c, "baton_propose_answer", await jsonBody(c)));
