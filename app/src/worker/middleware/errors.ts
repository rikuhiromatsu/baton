// エラーを { error: { code, message, details } } に揃える（設計書 4.1）
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApiError, errorBody } from "../lib/errors.ts";
import type { AppEnv } from "../types.ts";

export function onError(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status as 400);
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 400 ? "invalid" : "internal";
    return c.json(errorBody(code, err.message || code), status);
  }
  console.error("unhandled", err);
  return c.json(errorBody("internal", "internal error"), 500);
}

export function onNotFound(c: Context<AppEnv>): Response {
  return c.json(errorBody("not_found", "not found"), 404);
}
