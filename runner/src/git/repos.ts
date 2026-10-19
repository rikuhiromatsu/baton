// リポジトリの候補の走査（DESIGN-v2 3.2）。~/projects/*/ と ~/projects/*/*/ で .git を持つフォルダ。
// Baton 自身・node_modules 配下・外へのシンボリックリンクを除く。PUT /api/runner/repos で送る。
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { PutReposInput } from "@baton/shared";
import { resolveBase, runGit } from "./git.ts";

export type RepoItem = PutReposInput["items"][number];

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** .git がフォルダのものだけ（別のリポジトリの worktree・サブモジュールの .git ファイルは除く） */
async function hasGit(dir: string): Promise<boolean> {
  return (await lstat(path.join(dir, ".git")).catch(() => null))?.isDirectory() === true;
}

export async function scanRepos(opts: { root: string; exclude: string[] }): Promise<RepoItem[]> {
  const rootReal = await realpath(opts.root).catch(() => null);
  if (!rootReal) return [];
  const excludes = await Promise.all(opts.exclude.map((e) => realpath(e).catch(() => path.resolve(e))));
  const found: string[] = [];
  const consider = async (dir: string) => {
    const st = await lstat(dir).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink()) {
      const real = await realpath(dir).catch(() => null);
      if (!real || !inside(rootReal, real)) return false;
    } else if (!st.isDirectory()) return false;
    if (dir.split(path.sep).includes("node_modules")) return false;
    const real = await realpath(dir).catch(() => dir);
    if (excludes.some((e) => inside(e, real) || inside(real, e))) return false;
    if (await hasGit(dir)) {
      found.push(dir);
      return true;
    }
    return false;
  };
  for (const a of (await readdir(rootReal).catch(() => [] as string[])).sort()) {
    if (a.startsWith(".") || a === "node_modules") continue;
    const da = path.join(rootReal, a);
    if (await consider(da)) continue;
    for (const b of (await readdir(da).catch(() => [] as string[])).sort()) {
      if (b.startsWith(".") || b === "node_modules") continue;
      await consider(path.join(da, b));
    }
  }
  const items: RepoItem[] = [];
  for (const dir of found.slice(0, 500)) {
    const base = await resolveBase(dir, null).catch(() => null);
    const last = await runGit(["-C", dir, "log", "-1", "--format=%ct"], { allowFail: true });
    const dirty = (await runGit(["-C", dir, "status", "--porcelain", "--untracked-files=no"], { allowFail: true })).stdout.trim() !== "";
    items.push({
      path: dir,
      name: path.relative(rootReal, dir).split(path.sep).join("/"),
      defaultBranch: base?.ref && base.ref !== "HEAD" ? base.ref : null,
      headSha: base?.sha ?? null,
      lastCommitAt: last.code === 0 && last.stdout.trim() ? Number(last.stdout.trim()) * 1000 : null,
      dirty,
    });
  }
  return items;
}
