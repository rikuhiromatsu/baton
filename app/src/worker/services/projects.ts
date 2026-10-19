// プロジェクトを立てる（DESIGN-v2 3 章・D-51・D-95）
import { COO_THREAD_ID, type ProjectProposal } from "@baton/shared";
import type { Env } from "../env.ts";
import { createProjectWithTeam, type NewProject } from "../db/projects.ts";
import { toProposal, type ProposalRow, type RepoRow } from "../db/rows.ts";
import { inboxInsertStatements } from "../db/threads.ts";
import { conflict, invalid, notFound } from "../lib/errors.ts";

/** 候補にあるリポジトリか（CEO はパスを自由入力しない。D-51） */
export async function requireRepoCandidate(db: D1Database, repoPath: string): Promise<RepoRow> {
  const row = await db.prepare("SELECT * FROM runner_repos WHERE path = ?").bind(repoPath).first<RepoRow>();
  if (!row) throw invalid("repository is not a candidate", { repoPath });
  return row;
}

/** 他のプロジェクトに紐づいていないこと */
export async function requireRepoFree(db: D1Database, repoPath: string, exceptProjectId?: string): Promise<void> {
  const row = await db.prepare("SELECT id FROM projects WHERE repo_path = ?").bind(repoPath).first<{ id: string }>();
  if (row && row.id !== exceptProjectId) throw conflict("repository is already linked to another project", { projectId: row.id });
}

export async function repoNameMap(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT path, name FROM runner_repos").all<{ path: string; name: string }>();
  return new Map(results.map((r) => [r.path, r.name]));
}

export async function getProposal(db: D1Database, id: string): Promise<ProjectProposal | null> {
  const row = await db.prepare("SELECT * FROM project_proposals WHERE id = ?").bind(id).first<ProposalRow>();
  return row ? toProposal(row, await repoNameMap(db)) : null;
}

/** 立てる（プロジェクト・チーム・リーダーのスレッドを作り、COO の受信箱に project_created） */
export async function acceptProposal(
  env: Env,
  proposalId: string,
  workspaceOverride: NewProject["workspace"] | undefined,
): Promise<{ projectId: string; leaderThreadId: string }> {
  const db = env.DB;
  const row = await db.prepare("SELECT * FROM project_proposals WHERE id = ?").bind(proposalId).first<ProposalRow>();
  if (!row) throw notFound("proposal not found");
  if (row.status !== "pending") throw conflict("proposal is not pending", { status: row.status });
  const p = toProposal(row);
  const workspace: NewProject["workspace"] =
    workspaceOverride ?? (p.workspace.kind === "repo" ? { kind: "repo", repoPath: p.workspace.repoPath } : { kind: "baton" });
  if (workspace.kind === "repo") {
    await requireRepoCandidate(db, workspace.repoPath);
    await requireRepoFree(db, workspace.repoPath);
  }
  const now = Date.now();
  // 先に案を押さえる（二重の「立てる」で 2 つ作らない）
  const claimed = await db
    .prepare("UPDATE project_proposals SET status = 'accepted', decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(now, proposalId)
    .run();
  if (claimed.meta.changes !== 1) throw conflict("proposal is not pending");
  let created: { projectId: string; leaderThreadId: string };
  try {
    const r = await createProjectWithTeam(
      db,
      { name: p.name, slug: p.slug, goal: p.goal, summary: p.summary, workspace, leader: p.leader, members: p.members },
      now,
    );
    created = { projectId: r.project.id, leaderThreadId: r.leaderThreadId };
  } catch (err) {
    await db.prepare("UPDATE project_proposals SET status = 'pending', decided_at = NULL WHERE id = ?").bind(proposalId).run();
    throw err;
  }
  const where = workspace.kind === "repo" ? `既存リポジトリ ${workspace.repoPath}` : "Baton 専用";
  const inbox = inboxInsertStatements(
    db,
    {
      threadId: COO_THREAD_ID,
      kind: "project_created",
      wakes: true,
      payload: { text: `CEO がプロジェクト案「${p.name}」を立てた（プロジェクト ${created.projectId}、作業場所: ${where}）。最初の仕事をリーダーに振る`, projectId: created.projectId, proposalId },
    },
    now,
  );
  await db.batch([db.prepare("UPDATE project_proposals SET project_id = ? WHERE id = ?").bind(created.projectId, proposalId), ...inbox.stmts]);
  return created;
}
