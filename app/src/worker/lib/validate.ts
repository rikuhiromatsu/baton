// 入力の検査（@hono/zod-validator）と、開発時の出力の検査（設計書 4.1）
import { zValidator } from "@hono/zod-validator";
import type { Context, ValidationTargets } from "hono";
import type { z } from "zod";
import type { Env } from "../env.ts";
import { ApiError } from "./errors.ts";

export function v<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ApiError("invalid", "invalid input", result.error.issues.map((i) => ({ path: i.path, message: i.message })));
    }
  });
}

/** 本番以外では出力も契約のスキーマで検査する（ずれを早く見つけるため） */
export function checked<T>(env: Env, schema: z.ZodType<T>, data: T): T {
  if (env.BATON_ENV !== "production") {
    const r = schema.safeParse(data);
    if (!r.success) {
      throw new ApiError("internal", "output does not match contract", r.error.issues.map((i) => ({ path: i.path, message: i.message })));
    }
  }
  return data;
}

/** JSON 本文を読んで検査する（zValidator を使わない経路用） */
export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("invalid", "invalid json");
  }
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError("invalid", "invalid input", r.error.issues.map((i) => ({ path: i.path, message: i.message })));
  return r.data;
}
