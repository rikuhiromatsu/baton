// CSRF（設計書 6.3）。状態を変えるブラウザ用 API は X-Baton-CSRF と Origin の両方を検査
import type { MiddlewareHandler } from "hono";
import { CSRF_HEADER } from "@baton/shared";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../types.ts";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const session = c.get("session");
    const header = c.req.header(CSRF_HEADER);
    if (!session || !header || header !== session.csrf_token) throw new ApiError("forbidden", "csrf token mismatch");
    if (c.req.header("Origin") !== c.env.APP_ORIGIN) throw new ApiError("forbidden", "origin mismatch");
  }
  await next();
};

/** WebSocket は CORS の対象外なので Origin を必ず見る */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) throw new ApiError("forbidden", "origin mismatch");
  await next();
};
