// プロジェクトとチーム（設計書 3.1・4.3）
import type { ProjectWithTeam } from "@baton/shared";
import { toAgent, toProject, type AgentRow, type ProjectRow } from "./rows.ts";

export async function listProjects(db: D1Database): Promise<ProjectWithTeam[]> {
  const [projects, agents] = await db.batch([
    db.prepare("SELECT * FROM projects ORDER BY status, updated_at DESC"),
    db.prepare(
      "SELECT * FROM agents WHERE project_id IS NOT NULL ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, created_at, name",
    ),
  ]);
  const agentRows = (agents?.results ?? []) as AgentRow[];
  return ((projects?.results ?? []) as ProjectRow[]).map((p) => toProject(p, agentRows));
}

export async function getProject(db: D1Database, id: string): Promise<ProjectWithTeam | null> {
  const [projects, agents] = await db.batch([
    db.prepare("SELECT * FROM projects WHERE id = ?").bind(id),
    db
      .prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, created_at, name")
      .bind(id),
  ]);
  const row = (projects?.results?.[0] as ProjectRow | undefined) ?? null;
  return row ? toProject(row, (agents?.results ?? []) as AgentRow[]) : null;
}

export async function getCoo(db: D1Database) {
  const row = await db.prepare("SELECT * FROM agents WHERE role = 'coo' LIMIT 1").first<AgentRow>();
  return row ? toAgent(row) : null;
}

const SLUG_MAX = 40;

/** 使われていない slug を選ぶ。衝突したら末尾に -2、-3 … を付ける（設計書 5.2・8.2.1） */
export async function pickFreeSlug(db: D1Database, base: string): Promise<string> {
  const { results } = await db
    .prepare("SELECT slug FROM projects WHERE slug = ? OR slug LIKE ?")
    .bind(base, `${base.slice(0, SLUG_MAX - 2)}%`)
    .all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("no free slug");
}
