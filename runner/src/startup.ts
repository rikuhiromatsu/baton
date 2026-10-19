// 起動時の準備と見張り（DESIGN-v2 7.5・7.7・16.1・16.2）。
// - ~/baton-data の coo/・leaders/・worktrees/・logs/・run/・config/ を作る
// - 既存の Baton 専用プロジェクトを git にする（git init -b main と初期コミット）
// - D1 の workspaces（active・conflict）と git worktree list を突き合わせる。D1 にあってフォルダが無ければブランチから作り直す。
//   フォルダはあるが D1 に無ければ触らずログに残す。Baton の worktree の古い index.lock を消す
// - claude auth status（起動時と 1 時間ごと）
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ClaudeAuth } from "@baton/shared";
import { childEnv } from "./claude/env.ts";
import { dataPaths } from "./config.ts";
import type { RunnerContext } from "./context.ts";
import { errorMessage } from "./errors.ts";
import { addWorktree, branchExists, cleanStaleWorktreeLocks, ensureBatonRepo, listWorktrees } from "./git/git.ts";

export async function prepareDataDir(ctx: RunnerContext): Promise<void> {
  const p = dataPaths(ctx.config);
  for (const d of [p.coo, p.leaders, p.projects, p.worktrees, p.logs, p.run, p.config]) await mkdir(d, { recursive: true });
  for (const slug of await readdir(p.projects).catch(() => [] as string[])) {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) continue;
    await ensureBatonRepo(p.project(slug)).catch((err: unknown) => ctx.log.warn("Baton 専用のプロジェクトを git にできません", { slug, error: errorMessage(err) }));
  }
}

export async function reconcileWorkspaces(ctx: RunnerContext): Promise<{ restored: string[]; unknown: string[]; locksRemoved: string[] }> {
  const restored: string[] = [];
  const unknown: string[] = [];
  const locksRemoved: string[] = [];
  const worktreesRoot = dataPaths(ctx.config).worktrees;
  let rows: Awaited<ReturnType<typeof ctx.api.listWorkspaces>> = [];
  try {
    rows = [...(await ctx.api.listWorkspaces({ status: "active" })), ...(await ctx.api.listWorkspaces({ status: "conflict" }))];
  } catch (err) {
    ctx.log.warn("作業場所の一覧を取れません（突き合わせを飛ばします）", { error: errorMessage(err) });
    return { restored, unknown, locksRemoved };
  }
  const repos = new Set(rows.map((r) => r.repoPath));
  for (const w of rows) {
    if (existsSync(w.worktreePath)) continue;
    if (!(await branchExists(w.repoPath, w.branch))) {
      ctx.log.warn("作業場所のブランチがありません", { workspaceId: w.id, branch: w.branch });
      continue;
    }
    try {
      await addWorktree({ repo: w.repoPath, dir: w.worktreePath, branch: w.branch, startSha: w.headSha ?? w.baseSha, reason: `baton ${w.instructionId}` });
      restored.push(w.worktreePath);
    } catch (err) {
      ctx.log.warn("作業場所を作り直せません", { workspaceId: w.id, error: errorMessage(err) });
    }
  }
  const known = new Set(rows.map((r) => path.resolve(r.worktreePath)));
  for (const repo of repos) {
    for (const wt of await listWorktrees(repo)) {
      const rel = path.relative(worktreesRoot, wt.path);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (!known.has(path.resolve(wt.path))) unknown.push(wt.path);
    }
    locksRemoved.push(...(await cleanStaleWorktreeLocks(repo, worktreesRoot, ctx.config.limits.staleIndexLockMs).catch(() => [])));
  }
  if (unknown.length) ctx.log.info("D1 に無い worktree があります（触りません）", { paths: unknown });
  if (restored.length) ctx.log.info("worktree を作り直しました", { paths: restored });
  return { restored, unknown, locksRemoved };
}

/** claude auth status（JSON）。loggedIn と authMethod / subscriptionType を見る */
export function parseAuthStatus(stdout: string): ClaudeAuth {
  try {
    const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiProvider?: string };
    if (!j.loggedIn) return "not_logged_in";
    if (j.authMethod !== "claude.ai" || !j.subscriptionType) return "not_subscription";
    return "ok";
  } catch {
    return "unknown";
  }
}

export function checkClaudeAuth(ctx: RunnerContext): Promise<ClaudeAuth> {
  return new Promise((resolve) => {
    execFile(ctx.config.claudeBin, ["auth", "status"], { env: childEnv({ home: ctx.config.home, passthrough: process.env }), timeout: 30_000 }, (err, stdout) => {
      const state = err && !stdout ? "unknown" : parseAuthStatus(String(stdout));
      ctx.auth.authState = ctx.auth.tripped ? "not_subscription" : state;
      if (state !== "ok") ctx.log.warn("claude のログインを確かめてください", { state });
      resolve(state);
    });
  });
}
