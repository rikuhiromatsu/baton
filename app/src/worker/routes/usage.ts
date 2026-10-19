// GET /api/usage/today（設計書 4.2）
import { Hono } from "hono";
import { UsageTodaySchema } from "@baton/shared";
import { usageToday } from "../db/usage.ts";
import { checked } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const usageRoutes = new Hono<AppEnv>();

usageRoutes.get("/today", async (c) => c.json(checked(c.env, UsageTodaySchema, await usageToday(c.env.DB, Date.now()))));
