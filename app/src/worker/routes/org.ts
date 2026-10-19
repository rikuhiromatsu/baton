// 組織図・サイドパネル・プロジェクト・リポジトリ候補・プロファイル・枠（DESIGN-v2 12.2・13.3・13.9）
import { Hono } from "hono";
import {
  COO_THREAD_ID,
  CreateProjectFromRepoInput,
  CreateProjectFromRepoOutput,
  ListProfilesOutput,
  ListProjectsOutput,
  ListReposOutput,
  OrgSnapshotSchema,
  PatchProjectInput,
  ProjectWithTeamSchema,
  QuotaOutput,
  SidebarOutput,
  UI_TEXT_V2,
} from "@baton/shared";
import { buildOrg, buildSidebar } from "../db/org.ts";
import { getProject, hasActiveInstructions, listProjects, slugify } from "../db/projects.ts";
import { toRepo, type ProjectRow, type RepoRow } from "../db/rows.ts";
import { getProfiles, getQuota } from "../db/runners.ts";
import { inboxInsertStatements, messageInsertStatements } from "../db/threads.ts";
import { afterMessages, notifyRunners, projectEvents, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { startOfTokyoDay } from "../lib/time.ts";
import { checked, readJson } from "../lib/validate.ts";
import { getProposal, requireRepoCandidate, requireRepoFree } from "../services/projects.ts";
import type { AppEnv } from "../types.ts";

export const orgRoutes = new Hono<AppEnv>();
export const projectRoutes = new Hono<AppEnv>();
export const repoRoutes = new Hono<AppEnv>();
export const profileRoutes = new Hono<AppEnv>();
export const quotaRoutes = new Hono<AppEnv>();

orgRoutes.get("/", async (c) => c.json(checked(c.env, OrgSnapshotSchema, await buildOrg(c.env.DB, c.get("user").id, Date.now()))));

projectRoutes.get("/sidebar", async (c) => c.json(checked(c.env, SidebarOutput, await buildSidebar(c.env.DB, c.get("user").id, Date.now()))));

projectRoutes.get("/", async (c) => c.json(checked(c.env, ListProjectsOutput, { items: await listProjects(c.env.DB) })));

/** 目的・作業場所・元のブランチの変更。作業場所は動いている指示が無いときだけ（3.2） */
projectRoutes.patch("/:id", async (c) => {
  const input = await readJson(c, PatchProjectInput);
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
  if (!row) throw notFound("project not found");
  const sets = ["updated_at = ?"];
  const args: unknown[] = [Date.now()];
  if (input.repoPath !== undefined && input.repoPath !== row.repo_path) {
    if (await hasActiveInstructions(db, id)) throw conflict("project has active instructions");
    if (input.repoPath === null) {
      sets.push("workspace_kind = 'baton'", "repo_path = NULL", "base_branch = NULL");
    } else {
      await requireRepoCandidate(db, input.repoPath);
      await requireRepoFree(db, input.repoPath, id);
      sets.push("workspace_kind = 'repo'", "repo_path = ?");
      args.push(input.repoPath);
    }
  }
  if (input.baseBranch !== undefined) sets.push("base_branch = ?"), args.push(input.baseBranch);
  if (input.goal !== undefined) sets.push("goal = ?"), args.push(input.goal);
  try {
    await db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) throw conflict("repository is already linked to another project");
    throw err;
  }
  await publish(c.env, await projectEvents(c.env, id));
  return c.json(checked(c.env, ProjectWithTeamSchema, (await getProject(db, id))!));
});

/** 組織図の「リポジトリから作る」: プロジェクト案を作り、COO に知らせる（立てるのは同じ accept） */
projectRoutes.post("/", async (c) => {
  const input = await readJson(c, CreateProjectFromRepoInput);
  const db = c.env.DB;
  const repo = await requireRepoCandidate(db, input.repoPath);
  await requireRepoFree(db, input.repoPath);
  const now = Date.now();
  const proposalId = newId();
  const base = repo.name.split("/").pop() || repo.name;
  const payload = {
    name: base.slice(0, 40),
    slug: slugify(base),
    goal: "",
    summary: "",
    workspace: { kind: "repo", repoPath: repo.path },
    leader: { name: UI_TEXT_V2.roles.leader, specialty: "" },
    members: [{ name: UI_TEXT_V2.roles.member, specialty: "", profile: "generalist" }],
  };
  const msg = messageInsertStatements(
    db,
    { threadId: COO_THREAD_ID, authorKind: "system", kind: "project_proposal", body: "", ref: { proposalId }, notify: false },
    now,
  );
  const inbox = inboxInsertStatements(
    db,
    {
      threadId: COO_THREAD_ID,
      kind: "instruction_event",
      wakes: true,
      payload: { type: "proposal_from_repo", proposalId, text: `CEO が組織図からリポジトリ ${repo.name} のプロジェクト案を作った。目的とチームを CEO と固める` },
    },
    now,
  );
  await db.batch([
    ...msg.stmts,
    db
      .prepare("INSERT INTO project_proposals (id, thread_id, message_id, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .bind(proposalId, COO_THREAD_ID, msg.id, JSON.stringify(payload), now),
    ...inbox.stmts,
  ]);
  const proposal = (await getProposal(db, proposalId))!;
  await publish(c.env, [{ t: "project_proposal.upserted", proposal }]);
  await afterMessages(c.env, [msg.id], { push: false });
  await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.json(checked(c.env, CreateProjectFromRepoOutput, { proposal }), 201);
});

repoRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT r.*, (SELECT p.id FROM projects p WHERE p.repo_path = r.path) AS project_id FROM runner_repos r ORDER BY r.name",
  ).all<RepoRow>();
  return c.json(checked(c.env, ListReposOutput, { items: results.map(toRepo) }));
});

profileRoutes.get("/", async (c) => c.json(checked(c.env, ListProfilesOutput, { items: await getProfiles(c.env.DB) })));

quotaRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const quota = await getQuota(db);
  const since = startOfTokyoDay(Date.now());
  const cost = await db.prepare("SELECT COALESCE(sum(cost_usd_est), 0) AS usd FROM agent_sessions WHERE updated_at >= ?").bind(since).first<{ usd: number }>();
  return c.json(checked(c.env, QuotaOutput, { ...quota, estimatedCostTodayUsd: cost?.usd ?? 0 }));
});
