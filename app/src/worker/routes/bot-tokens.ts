// 秘書のトークン（設定の「秘書」。DESIGN-v2 11.3・11.6・12.2）
import { Hono } from "hono";
import { BOT_TOKEN_PREFIX, BotAuditOutput, BotAuditQuery, CreateBotTokenInput, CreateBotTokenOutput, ListBotTokensOutput } from "@baton/shared";
import { toBotAudit, toBotToken, type BotAuditRow, type BotTokenRow } from "../db/rows.ts";
import { newId, randomToken, sha256Hex } from "../lib/crypto.ts";
import { invalid, notFound } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const botTokenRoutes = new Hono<AppEnv>();

const AUDIT_PAGE = 50;

/** トークンの本体（btn_bot_ ＋ 32 バイトの乱数の base64url） */
export function newBotToken(): string {
  return `${BOT_TOKEN_PREFIX}${randomToken(32)}`;
}

botTokenRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM bot_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC").all<BotTokenRow>();
  return c.json(checked(c.env, ListBotTokensOutput, { items: results.map(toBotToken) }));
});

/** 本体はこの応答で 1 回だけ返す。D1 には SHA-256 だけ */
botTokenRoutes.post("/", async (c) => {
  const input = await readJson(c, CreateBotTokenInput);
  const token = newBotToken();
  const id = newId();
  const now = Date.now();
  const scopes = [...new Set(input.scopes)];
  await c.env.DB.prepare("INSERT INTO bot_tokens (id, name, token_hash, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, input.name, await sha256Hex(token), JSON.stringify(scopes), c.get("user").id, now)
    .run();
  const row = (await c.env.DB.prepare("SELECT * FROM bot_tokens WHERE id = ?").bind(id).first<BotTokenRow>())!;
  return c.json(checked(c.env, CreateBotTokenOutput, { token, item: toBotToken(row) }), 201);
});

botTokenRoutes.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare("UPDATE bot_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(Date.now(), c.req.param("id")).run();
  if (res.meta.changes !== 1) throw notFound("token not found");
  return c.body(null, 204);
});

botTokenRoutes.get("/:id/audit", async (c) => {
  const q = BotAuditQuery.safeParse({ cursor: c.req.query("cursor") || undefined });
  if (!q.success) throw invalid("invalid query");
  const offset = q.data.cursor && /^\d+$/.test(q.data.cursor) ? Number(q.data.cursor) : 0;
  const exists = await c.env.DB.prepare("SELECT 1 AS ok FROM bot_tokens WHERE id = ?").bind(c.req.param("id")).first();
  if (!exists) throw notFound("token not found");
  const { results } = await c.env.DB.prepare("SELECT * FROM bot_audit_log WHERE token_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
    .bind(c.req.param("id"), AUDIT_PAGE + 1, offset)
    .all<BotAuditRow>();
  const hasMore = results.length > AUDIT_PAGE;
  return c.json(checked(c.env, BotAuditOutput, { items: results.slice(0, AUDIT_PAGE).map(toBotAudit), nextCursor: hasMore ? String(offset + AUDIT_PAGE) : null }));
});
