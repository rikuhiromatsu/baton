// 秘書 bot のトークン認証（DESIGN-v2 11.3）。Authorization: Bearer btn_bot_…（Bearer の無い btn_bot_… も受ける）。Cookie は見ない（CSRF の対象外）
import type { MiddlewareHandler } from "hono";
import { BOT_TOKEN_PREFIX } from "@baton/shared";
import { sha256Hex } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import type { BotTokenRow } from "../db/rows.ts";
import type { AppEnv } from "../types.ts";

export async function findBotToken(db: D1Database, authorization: string | undefined): Promise<BotTokenRow | null> {
  // xAI の Remote MCP の authorization は「Authorization ヘッダに入るトークン」とだけあり、Bearer を付けるかが書かれていない。
  // 前置きの無いトークンだけでも受ける（btn_bot_ で始まるものに限る）
  const m = /^(?:Bearer\s+)?(\S+)$/i.exec(authorization?.trim() ?? "");
  const token = m?.[1];
  if (!token || !token.startsWith(BOT_TOKEN_PREFIX)) return null;
  return db.prepare("SELECT * FROM bot_tokens WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256Hex(token)).first<BotTokenRow>();
}

export async function touchBotToken(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE bot_tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

export const requireBot: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await findBotToken(c.env.DB, c.req.header("Authorization"));
  if (!row) throw new ApiError("unauthorized", "bot token required");
  c.set("botToken", row);
  await touchBotToken(c.env.DB, row.id, Date.now());
  await next();
};
