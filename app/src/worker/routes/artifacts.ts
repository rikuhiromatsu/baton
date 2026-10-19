// GET /api/artifacts/:id（設計書 4.2）
import { Hono } from "hono";
import { ArtifactSchema } from "@baton/shared";
import { ARTIFACT_SELECT } from "../db/details.ts";
import { toArtifact, type ArtifactRow } from "../db/rows.ts";
import { notFound } from "../lib/errors.ts";
import { checked } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const artifactRoutes = new Hono<AppEnv>();

artifactRoutes.get("/:id", async (c) => {
  const row = await c.env.DB.prepare(`${ARTIFACT_SELECT} WHERE a.id = ?`).bind(c.req.param("id")).first<ArtifactRow>();
  if (!row) throw notFound("artifact not found");
  return c.json(checked(c.env, ArtifactSchema, toArtifact(row)));
});
