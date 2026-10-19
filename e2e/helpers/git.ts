// E2E から git の様子を確かめる道具（シナリオ A9・B2・B3 の「本体が変わらない」）。
// ランナーの作業フォルダ（Baton 専用の本体・worktree）と sample-repo は同じ Mac の一時フォルダにあるので直接見られる。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

/** 本体の「触られていないこと」を比べるための写し（HEAD・チェックアウト中のブランチ・作業ツリーと index の状態・remote） */
export type RepoSnapshot = { head: string; branch: string; status: string; remotes: string; stash: string };

export function snapshotRepo(repo: string): RepoSnapshot {
  return {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "symbolic-ref", "--short", "HEAD"),
    // 未追跡も含めた作業ツリーと index（ファイルの中身の変化は diff のハッシュで見る）
    status: `${git(repo, "status", "--porcelain=v1", "--untracked-files=all")}\n${git(repo, "diff", "HEAD")}`,
    remotes: git(repo, "remote", "-v"),
    stash: git(repo, "stash", "list"),
  };
}

export function branches(repo: string, pattern = "baton/*"): string[] {
  const out = git(repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${pattern}`);
  return out ? out.split("\n") : [];
}

/**
 * 既存リポジトリの見本（14.2 B3・15.3 の sample-repo）。本人の作業中を真似て、
 * 未コミットの変更・未追跡のファイル・別のブランチのチェックアウト・失敗するフックを入れておく（R14 と同じ条件）
 */
export function createSampleRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => git(dir, ...args);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  run("config", "user.name", "Sample Owner");
  run("config", "user.email", "owner@example.com");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# sample-repo\n\nE2E 用の既存リポジトリ。\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# sample-repo の決まり\n\n- 変更は小さく\n");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/index.js"), "export const hello = () => 'hello';\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  // 本人は別のブランチで作業中
  run("checkout", "-q", "-b", "owner/wip");
  fs.writeFileSync(path.join(dir, "src/index.js"), "export const hello = () => 'hello, wip';\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "未追跡のメモ\n");
  // 失敗するフック（Baton はフックを無効にしてコミットする。7.3）
  const hook = path.join(dir, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'sample-repo の pre-commit は失敗する' >&2\nexit 1\n", { mode: 0o755 });
  return dir;
}
