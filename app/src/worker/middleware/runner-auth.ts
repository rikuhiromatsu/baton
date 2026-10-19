// ランナーの Bearer トークン認証（設計書 6.4）。ハッシュの完全一致で引く
import type { MiddlewareHandler } from "hono";
import { sha256Hex } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import type { RunnerRow } from "../db/rows.ts";
import type { AppEnv } from "../types.ts";

export const requireRunner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m?.[1]) throw new ApiError("unauthorized", "runner token required");
  const row = await c.env.DB.prepare("SELECT * FROM runners WHERE token_hash = ? AND revoked = 0")
    .bind(await sha256Hex(m[1]))
    .first<RunnerRow>();
  if (!row) throw new ApiError("unauthorized", "invalid runner token");
  c.set("runner", row);
  await next();
};
