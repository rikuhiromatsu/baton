// 作業場所（DESIGN-v2 7.3〜7.5）: 指示×プロジェクトの統合用と、メンバーのタスクごとの worktree。D1 の workspaces と対で持つ。
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ProjectWithTeam, Workspace } from "@baton/shared";
import { dataPaths } from "../config.ts";
import type { RunnerContext } from "../context.ts";
import {
  addWorktree,
  branchExists,
  deleteBranch,
  ensureBatonRepo,
  headSha,
  listBranches,
  removeWorktree,
  resolveBase,
  runGit,
  withRepoLock,
  BATON_IDENTITY,
} from "./git.ts";

export function remember(ctx: RunnerContext, ws: Workspace): Workspace {
  ctx.coord.workspaces.set(ws.id, ws);
  return ws;
}

export const id8 = (id: string) => id.replace(/-/g, "").slice(0, 8);

/** プロジェクトの本体（Baton 専用は git にしてから返す） */
export async function projectRepo(ctx: RunnerContext, project: ProjectWithTeam): Promise<string> {
  if (project.workspaceKind === "repo") {
    if (!project.repoPath) throw new Error("既存リポジトリのパスがありません");
    return project.repoPath;
  }
  const dir = dataPaths(ctx.config).project(project.slug);
  await ensureBatonRepo(dir);
  return dir;
}

function lockDelays(ctx: RunnerContext): number[] {
  return ctx.config.limits.gitLockRetryDelaysMs;
}

/** 統合用（無ければ作る。D1 にあってフォルダが無ければブランチから作り直す。7.5） */
export async function ensureIntegration(
  ctx: RunnerContext,
  input: { instructionId: string; project: ProjectWithTeam; workspaces: Workspace[] },
): Promise<Workspace> {
  const repo = await projectRepo(ctx, input.project);
  const short = id8(input.instructionId);
  const dir = dataPaths(ctx.config).worktree(short, input.project.slug, "integration");
  const branch = `baton/${short}/integration`;
  const existing = input.workspaces.find((w) => w.purpose === "integration" && w.projectId === input.project.id && (w.status === "active" || w.status === "kept"));
  if (existing) {
    if (!existsSync(existing.worktreePath)) {
      await addWorktree({ repo, dir: existing.worktreePath, branch: existing.branch, startSha: existing.headSha ?? existing.baseSha, reason: `baton ${input.instructionId}`, lockDelays: lockDelays(ctx) });
    }
    if (existing.status === "kept") return remember(ctx, await ctx.api.patchWorkspace(existing.id, { status: "active" }));
    return remember(ctx, existing);
  }
  const kind = input.project.workspaceKind;
  // reopen（7.5）: Baton 専用は main から、既存リポジトリは残した統合用ブランチから
  const base = kind === "baton" ? await resolveBase(repo, "main") : await resolveBase(repo, input.project.baseBranch);
  const keptBranch = kind === "repo" && (await branchExists(repo, branch));
  await addWorktree({ repo, dir, branch, startSha: base.sha, reason: `baton ${input.instructionId}`, lockDelays: lockDelays(ctx) });
  return remember(ctx, await ctx.api.createWorkspace({
    id: randomUUID(),
    instructionId: input.instructionId,
    projectId: input.project.id,
    purpose: "integration",
    taskId: null,
    parentId: null,
    kind,
    repoPath: repo,
    worktreePath: dir,
    branch,
    baseRef: keptBranch ? branch : base.ref,
    baseSha: base.sha,
  }));
}

/** タスク用（起動時点の統合用の先頭から。7.3） */
export async function createTaskWorktree(
  ctx: RunnerContext,
  input: { instructionId: string; project: ProjectWithTeam; integration: Workspace; taskId: string; name: string },
): Promise<Workspace> {
  const repo = input.integration.repoPath;
  const short = id8(input.instructionId);
  let name = input.name;
  let branch = `baton/${short}/${name}`;
  let dir = dataPaths(ctx.config).worktree(short, input.project.slug, name);
  // 同じ名前が残っていれば（再作成・ラウンドの上限で同じ番号）別名にする
  for (let i = 2; (await branchExists(repo, branch)) || existsSync(dir); i++) {
    name = `${input.name}-${i}`;
    branch = `baton/${short}/${name}`;
    dir = dataPaths(ctx.config).worktree(short, input.project.slug, name);
  }
  const start = await headSha(input.integration.worktreePath);
  await addWorktree({ repo, dir, branch, startSha: start, reason: `baton ${input.instructionId}`, lockDelays: lockDelays(ctx) });
  return remember(ctx, await ctx.api.createWorkspace({
    id: randomUUID(),
    instructionId: input.instructionId,
    projectId: input.project.id,
    purpose: "task",
    taskId: input.taskId,
    parentId: input.integration.id,
    kind: input.integration.kind,
    repoPath: repo,
    worktreePath: dir,
    branch,
    baseRef: input.integration.branch,
    baseSha: start,
  }));
}

/** D1 にあってフォルダが無いタスク用をブランチから作り直す（再起動・追加の依頼。7.5） */
export async function restoreWorktree(ctx: RunnerContext, ws: Workspace, instructionId: string): Promise<void> {
  if (existsSync(ws.worktreePath)) return;
  await addWorktree({ repo: ws.repoPath, dir: ws.worktreePath, branch: ws.branch, startSha: ws.headSha ?? ws.baseSha, reason: `baton ${instructionId}`, lockDelays: lockDelays(ctx) });
}

export type FinalizeOutcome = { outcome: "merged" | "kept" | "conflict" | "removed" | "failed"; branch: string | null; error?: string };

/** 確定（承認から 20 秒後。7.5）。Baton 専用は main に取り込む、既存リポジトリは統合用ブランチを残す */
export async function finalizeWorkspaces(ctx: RunnerContext, input: { instructionId: string; project: ProjectWithTeam; workspaces: Workspace[] }): Promise<FinalizeOutcome> {
  const worktreesRoot = dataPaths(ctx.config).worktrees;
  const integration = input.workspaces.find((w) => w.purpose === "integration" && w.projectId === input.project.id);
  const tasks = input.workspaces.filter((w) => w.purpose === "task" && w.projectId === input.project.id);
  if (!integration) return { outcome: "removed", branch: null };
  const repo = integration.repoPath;
  const short = id8(input.instructionId);
  const removeTasks = async () => {
    for (const t of tasks) {
      await removeWorktree({ repo, dir: t.worktreePath, worktreesRoot }).catch((err: unknown) => ctx.log.warn("worktree を消せません", { dir: t.worktreePath, error: String(err) }));
      if (t.status !== "removed") await ctx.api.patchWorkspace(t.id, { status: t.status === "conflict" ? "kept" : "removed", finalized: true }).catch(() => undefined);
    }
  };
  if (integration.kind === "baton") {
    // 統合用を main に --no-ff で取り込む（本体は Baton 専用のフォルダ。main がチェックアウトされている）
    const merged = await withRepoLock(repo, async () => {
      const current = (await runGit(["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).stdout.trim();
      if (current !== "main") return { ok: false, error: `本体が main ではありません（${current || "detached"}）` };
      const r = await runGit(["-C", repo, ...BATON_IDENTITY, "-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "--no-edit", integration.branch], { allowFail: true });
      if (r.code === 0) return { ok: true, error: null };
      await runGit(["-C", repo, "merge", "--abort"], { allowFail: true });
      return { ok: false, error: r.stderr.trim().slice(0, 1000) || "取り込めませんでした" };
    });
    if (!merged.ok) {
      await ctx.api.patchWorkspace(integration.id, { status: "kept", error: merged.error, finalized: true }).catch(() => undefined);
      return { outcome: "kept", branch: integration.branch, error: merged.error ?? undefined };
    }
    await removeTasks();
    await removeWorktree({ repo, dir: integration.worktreePath, worktreesRoot });
    for (const b of await listBranches(repo, `baton/${short}/`)) await deleteBranch(repo, b);
    await ctx.api.patchWorkspace(integration.id, { status: "merged", finalized: true }).catch(() => undefined);
    return { outcome: "merged", branch: null };
  }
  // 既存リポジトリ: 取り込まない・push しない。統合用 worktree とタスク用ブランチを消し、統合用ブランチを残す
  await removeTasks();
  await removeWorktree({ repo, dir: integration.worktreePath, worktreesRoot, commitFirst: null });
  for (const b of await listBranches(repo, `baton/${short}/`)) if (b !== integration.branch) await deleteBranch(repo, b);
  await ctx.api.patchWorkspace(integration.id, { status: "kept", finalized: true }).catch(() => undefined);
  return { outcome: "kept", branch: integration.branch };
}

export function taskWorktreeName(planKey: string | null, taskId: string, round: number): string {
  const key = planKey && /^t\d{1,2}$/.test(planKey) ? planKey : `x${taskId.replace(/-/g, "").slice(0, 6)}`;
  return `${key}-r${round}`;
}

export function relInside(root: string, p: string): string | null {
  const rel = path.relative(root, path.resolve(root, p));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
