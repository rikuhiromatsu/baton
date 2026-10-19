// プロジェクトとチーム（v1 設計書 3.1、DESIGN-v2 3 章）
import type { MemberProfile, ProjectWithTeam } from "@baton/shared";
import { newId } from "../lib/crypto.ts";
import { conflict } from "../lib/errors.ts";
import { toProject, type AgentRow, type ProjectRow } from "./rows.ts";

const PROJECT_SELECT = `SELECT p.*, (SELECT r.name FROM runner_repos r WHERE r.path = p.repo_path) AS repo_name FROM projects p`;
const AGENT_ORDER = "ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, created_at, name";

export async function listProjects(db: D1Database, opts: { activeOnly?: boolean } = {}): Promise<ProjectWithTeam[]> {
  const [projects, agents] = await db.batch([
    db.prepare(`${PROJECT_SELECT} ${opts.activeOnly ? "WHERE p.status = 'active'" : ""} ORDER BY p.status, p.updated_at DESC`),
    db.prepare(`SELECT * FROM agents WHERE project_id IS NOT NULL ${AGENT_ORDER}`),
  ]);
  const agentRows = (agents?.results ?? []) as AgentRow[];
  return ((projects?.results ?? []) as ProjectRow[]).map((p) => toProject(p, agentRows));
}

export async function getProject(db: D1Database, id: string): Promise<ProjectWithTeam | null> {
  const [projects, agents] = await db.batch([
    db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(id),
    db.prepare(`SELECT * FROM agents WHERE project_id = ? ${AGENT_ORDER}`).bind(id),
  ]);
  const row = (projects?.results?.[0] as ProjectRow | undefined) ?? null;
  return row ? toProject(row, (agents?.results ?? []) as AgentRow[]) : null;
}

/** プロジェクトのリーダーのスレッドの ID（0002 の移し替えと同じ形） */
export function leaderThreadIdOf(projectId: string): string {
  return `thread-${projectId}`;
}

const SLUG_MAX = 40;

/** 使われていない slug を選ぶ。衝突したら末尾に -2、-3 … を付ける */
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

/** フォルダ名などから slug を作る（^[a-z0-9][a-z0-9-]{1,39}$） */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(s) ? s : `project-${s || "x"}`.slice(0, SLUG_MAX).replace(/-+$/, "");
}

export type NewProject = {
  name: string;
  slug: string;
  goal: string;
  summary: string;
  workspace: { kind: "baton" } | { kind: "repo"; repoPath: string };
  leader: { name: string; specialty: string };
  members: { name: string; specialty: string; profile: MemberProfile }[];
};

/**
 * プロジェクト・チーム（リーダー＋メンバー）・リーダーのスレッドを 1 つのトランザクションで作る（3.2）。
 * slug が衝突したら -2、-3 … を付ける。既存リポジトリが他のプロジェクトに紐づいていれば 409。
 */
export async function createProjectWithTeam(db: D1Database, input: NewProject, now: number): Promise<{ project: ProjectWithTeam; leaderThreadId: string }> {
  for (let tries = 0; tries < 3; tries++) {
    const slug = await pickFreeSlug(db, input.slug);
    const projectId = newId();
    const leaderId = newId();
    const threadId = leaderThreadIdOf(projectId);
    const repoPath = input.workspace.kind === "repo" ? input.workspace.repoPath : null;
    const stmts = [
      db
        .prepare(
          `INSERT INTO projects (id, slug, name, summary, status, created_at, updated_at, workspace_kind, repo_path, base_branch, goal)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(projectId, slug, input.name, input.summary, now, now, input.workspace.kind, repoPath, input.goal),
      db
        .prepare("INSERT INTO agents (id, project_id, role, name, specialty, model, active, created_at, profile) VALUES (?, ?, 'leader', ?, ?, NULL, 1, ?, 'leader')")
        .bind(leaderId, projectId, input.leader.name, input.leader.specialty, now),
      ...input.members.map((m, n) =>
        db
          .prepare("INSERT INTO agents (id, project_id, role, name, specialty, model, active, created_at, profile) VALUES (?, ?, 'member', ?, ?, NULL, 1, ?, ?)")
          .bind(newId(), projectId, m.name, m.specialty, now + 1 + n, m.profile),
      ),
      db
        .prepare("INSERT INTO threads (id, kind, project_id, agent_id, status, created_at, updated_at) VALUES (?, 'leader', ?, ?, 'idle', ?, ?)")
        .bind(threadId, projectId, leaderId, now, now),
    ];
    try {
      await db.batch(stmts);
    } catch (err) {
      const msg = String(err);
      if (/UNIQUE/i.test(msg) && /slug/i.test(msg)) continue;
      if (/UNIQUE/i.test(msg) && /repo_path/i.test(msg)) throw conflict("repository is already linked to another project");
      throw err;
    }
    return { project: (await getProject(db, projectId))!, leaderThreadId: threadId };
  }
  throw conflict("could not allocate slug");
}

/** 動いている指示（作業場所を変えられない状態）があるか */
export async function hasActiveInstructions(db: D1Database, projectId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM instructions WHERE project_id = ? AND status IN ('queued','running','needs_decision','review') LIMIT 1")
    .bind(projectId)
    .first();
  return row !== null;
}
