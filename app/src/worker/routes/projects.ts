// GET /api/projects（設計書 4.2）
import { Hono } from "hono";
import { ListProjectsOutput } from "@baton/shared";
import { listProjects } from "../db/projects.ts";
import { checked } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get("/", async (c) => c.json(checked(c.env, ListProjectsOutput, { items: await listProjects(c.env.DB) })));
