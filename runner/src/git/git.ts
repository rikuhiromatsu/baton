// git の操作（DESIGN-v2 7.3〜7.5、D-49・D-50・D-82・D-83）。
// - 本体（既存リポジトリ）の作業ツリー・チェックアウト中のブランチ・index に書かない。push・fetch・pull・本体への merge をしない
// - リポジトリ（本体）ごとに git 操作を直列に。index.lock の失敗は 1・3・10 秒で 3 回やり直す
// - コミット・マージはランナーがフック無しで（core.hooksPath=/dev/null・--no-verify）
// - 消すのは <DATA>/worktrees/ の配下だけ（realpath で検査）
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS, type DiffStatEntry } from "@baton/shared";
import { sleep } from "../sync.ts";

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.code = code;
    this.stderr = stderr;
    this.name = "GitError";
  }
}

export const BATON_IDENTITY = ["-c", "user.name=Baton", "-c", "user.email=baton@baton.local"];
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** git に渡す環境（ランナーの GIT_* は渡さない。対話のプロンプトを出さない） */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  return env;
}

export type GitResult = { stdout: string; stderr: string; code: number };

export function runGit(args: string[], opts: { cwd?: string; allowFail?: boolean; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts.cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      if (err && !opts.allowFail) {
        reject(new GitError(`git ${args.filter((a) => !a.startsWith("user.")).slice(0, 6).join(" ")} に失敗: ${String(stderr).trim().slice(0, 500)}`, code, String(stderr)));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

// ───────────── ロック（D-83） ─────────────

const repoLocks = new Map<string, Promise<unknown>>();

async function lockKey(repo: string): Promise<string> {
  try {
    return await realpath(repo);
  } catch {
    return path.resolve(repo);
  }
}

/** 本体ごとに直列に実行する */
export async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(repo);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const job = prev.catch(() => undefined).then(fn);
  repoLocks.set(key, job);
  try {
    return await job;
  } finally {
    if (repoLocks.get(key) === job) repoLocks.delete(key);
  }
}

/** index.lock・ref のロックの失敗だけ 1・3・10 秒でやり直す */
export async function retryOnLock<T>(fn: () => Promise<T>, delays: readonly number[] = [1000, 3000, 10_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof GitError ? err.stderr : String(err);
      const d = delays[i];
      if (d === undefined || !/\.lock'?: File exists|Unable to create .*\.lock|cannot lock ref|index\.lock/i.test(msg)) throw err;
      await sleep(d);
    }
  }
}

// ───────────── 本体 ─────────────

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await runGit(["-C", dir, "rev-parse", "--is-inside-work-tree"], { allowFail: true });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Baton 専用の本体を git にする（git init -b main と初期コミット。16.1・7.3） */
export async function ensureBatonRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (existsSync(path.join(dir, ".git"))) return;
  await runGit(["-C", dir, "init", "-b", "main"]);
  const gi = path.join(dir, ".gitignore");
  const prev = await readFile(gi, "utf8").catch(() => "");
  if (!prev.includes(".baton/history/")) await writeFile(gi, `${prev}${prev && !prev.endsWith("\n") ? "\n" : ""}.baton/history/\n`);
  await runGit(["-C", dir, "add", "-A"]);
  await runGit(["-C", dir, ...BATON_IDENTITY, ...NO_HOOKS, "commit", "--no-verify", "--allow-empty", "-m", "Baton: 初期コミット"]);
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  const r = await runGit(["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** 元にするブランチと SHA（既存リポジトリは base_branch → refs/remotes/origin/HEAD → main → master の手元の先頭。7.3） */
export async function resolveBase(repo: string, baseBranch: string | null): Promise<{ ref: string; sha: string }> {
  const candidates: string[] = [];
  if (baseBranch) candidates.push(baseBranch);
  const originHead = await runGit(["-C", repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (originHead.code === 0 && originHead.stdout.trim()) {
    const short = originHead.stdout.trim().replace(/^origin\//, "");
    candidates.push(short);
  }
  candidates.push("main", "master");
  for (const c of candidates) {
    const sha = (await revParse(repo, `refs/heads/${c}`)) ?? null;
    if (sha) return { ref: c, sha };
  }
  // 手元にブランチが無ければ origin の先頭（fetch はしない）
  const sha = await revParse(repo, "HEAD");
  if (sha) return { ref: "HEAD", sha };
  throw new GitError("元にするブランチが見つかりません", null, "");
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await revParse(repo, `refs/heads/${branch}`)) !== null;
}

/** worktree を作ってロックする（既にブランチがあればそれを使う＝再起動での作り直し） */
export async function addWorktree(input: { repo: string; dir: string; branch: string; startSha: string; reason: string; lockDelays?: number[] }): Promise<void> {
  await mkdir(path.dirname(input.dir), { recursive: true });
  await withRepoLock(input.repo, () =>
    retryOnLock(async () => {
      if (existsSync(input.dir) && (await isGitRepo(input.dir))) return;
      if (await branchExists(input.repo, input.branch)) await runGit(["-C", input.repo, ...NO_HOOKS, "worktree", "add", input.dir, input.branch]);
      else await runGit(["-C", input.repo, ...NO_HOOKS, "worktree", "add", "-b", input.branch, input.dir, input.startSha]);
      await runGit(["-C", input.repo, "worktree", "lock", "--reason", input.reason, input.dir], { allowFail: true });
    }, input.lockDelays),
  );
}

export async function headSha(dir: string): Promise<string> {
  return (await runGit(["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

/** タスク用をコミット（変更が無ければ null） */
export async function commitAll(input: { repo: string; dir: string; message: string; lockDelays?: number[] }): Promise<string | null> {
  return withRepoLock(input.repo, () =>
    retryOnLock(async () => {
      await runGit(["-C", input.dir, "add", "-A"]);
      const staged = await runGit(["-C", input.dir, "diff", "--cached", "--quiet"], { allowFail: true });
      if (staged.code === 0) {
        // MERGE_HEAD があれば（衝突の解決タスク）変更が無くてもマージのコミットを作る
        const mergeHead = await runGit(["-C", input.dir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFail: true });
        if (mergeHead.code !== 0) return null;
      }
      await runGit(["-C", input.dir, ...BATON_IDENTITY, ...NO_HOOKS, "commit", "--no-verify", "-m", input.message]);
      return headSha(input.dir);
    }, input.lockDelays),
  );
}

export type MergeResult = { ok: true; sha: string } | { ok: false; files: string[] };

/** 統合用へ取り込む（--no-ff、フック無効）。衝突なら --abort してファイルを返す（7.4） */
export async function mergeBranch(input: { repo: string; dir: string; branch: string; lockDelays?: number[] }): Promise<MergeResult> {
  return withRepoLock(input.repo, () =>
    retryOnLock(async () => {
      const r = await runGit(["-C", input.dir, ...BATON_IDENTITY, ...NO_HOOKS, "merge", "--no-ff", "--no-edit", input.branch], { allowFail: true });
      if (r.code === 0) return { ok: true as const, sha: await headSha(input.dir) };
      if (/\.lock'?: File exists|index\.lock/i.test(r.stderr)) throw new GitError("lock", r.code, r.stderr);
      const files = (await runGit(["-C", input.dir, "diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.split("\n").filter(Boolean);
      await runGit(["-C", input.dir, "merge", "--abort"], { allowFail: true });
      return { ok: false as const, files: files.length ? files : ["（不明）"] };
    }, input.lockDelays),
  );
}

/** 衝突の解決タスク: 統合用の先頭から切った worktree に、衝突の印を入れて渡す（--no-commit） */
export async function mergeWithMarkers(input: { repo: string; dir: string; branch: string }): Promise<string[]> {
  return withRepoLock(input.repo, async () => {
    await runGit(["-C", input.dir, ...BATON_IDENTITY, ...NO_HOOKS, "merge", "--no-ff", "--no-commit", input.branch], { allowFail: true });
    return (await runGit(["-C", input.dir, "diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.split("\n").filter(Boolean);
  });
}

/** 差分（--numstat と先頭 200,000 文字の patch） */
export async function diffSince(dir: string, baseSha: string): Promise<{ stat: DiffStatEntry[]; patch: string; truncated: boolean; text: string }> {
  const num = (await runGit(["-C", dir, "diff", "--numstat", "-M", `${baseSha}..HEAD`])).stdout;
  const names = (await runGit(["-C", dir, "diff", "--name-status", "-M", `${baseSha}..HEAD`])).stdout;
  const changeByPath = new Map<string, "A" | "M" | "D" | "R">();
  for (const line of names.split("\n").filter(Boolean)) {
    const [st, ...rest] = line.split("\t");
    const p = rest[rest.length - 1] ?? "";
    const c = (st ?? "M")[0] as string;
    changeByPath.set(p, c === "A" || c === "D" || c === "R" ? c : "M");
  }
  const stat: DiffStatEntry[] = [];
  for (const line of num.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    let p = rest.join("\t");
    // 名前の変更は "old => new" や "dir/{a => b}" の形
    if (p.includes(" => ")) p = p.replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/^.* => /, "");
    stat.push({ path: p, added: Number(a) || 0, removed: Number(d) || 0, change: changeByPath.get(p) ?? "M" });
  }
  const full = (await runGit(["-C", dir, "diff", "-M", `${baseSha}..HEAD`])).stdout;
  const truncated = full.length > LIMITS.diffPatchMaxChars;
  const text = stat.map((s) => `${s.change} ${s.path} +${s.added} -${s.removed}`).join("\n");
  return { stat, patch: truncated ? full.slice(0, LIMITS.diffPatchMaxChars) : full, truncated, text };
}

/** 消してよい場所か（<DATA>/worktrees/ の配下だけ。realpath で検査。7.5） */
export async function assertUnderWorktrees(worktreesRoot: string, dir: string): Promise<void> {
  const root = await realpath(worktreesRoot).catch(() => path.resolve(worktreesRoot));
  const real = await realpath(dir).catch(() => path.resolve(dir));
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new GitError(`worktrees の外は消せません: ${dir}`, null, "");
}

/** worktree を消す（未コミットがあれば commitFirst のときだけコミットしてから） */
export async function removeWorktree(input: { repo: string; dir: string; worktreesRoot: string; commitFirst?: string | null }): Promise<void> {
  if (!existsSync(input.dir)) {
    await withRepoLock(input.repo, () => runGit(["-C", input.repo, "worktree", "prune", "--expire", "now"], { allowFail: true }).then(() => undefined));
    return;
  }
  await assertUnderWorktrees(input.worktreesRoot, input.dir);
  if (input.commitFirst) await commitAll({ repo: input.repo, dir: input.dir, message: input.commitFirst }).catch(() => null);
  await withRepoLock(input.repo, async () => {
    await runGit(["-C", input.repo, "worktree", "unlock", input.dir], { allowFail: true });
    const r = await runGit(["-C", input.repo, "worktree", "remove", "--force", "--force", input.dir], { allowFail: true });
    if (r.code !== 0 && existsSync(input.dir)) {
      await assertUnderWorktrees(input.worktreesRoot, input.dir);
      await rm(input.dir, { recursive: true, force: true });
      await runGit(["-C", input.repo, "worktree", "prune", "--expire", "now"], { allowFail: true });
    }
  });
}

/** Baton のブランチ（baton/ で始まるもの）だけ消す */
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  if (!branch.startsWith("baton/")) throw new GitError(`Baton のブランチ以外は消しません: ${branch}`, null, "");
  await withRepoLock(repo, () => runGit(["-C", repo, "branch", "-D", branch], { allowFail: true }).then(() => undefined));
}

export async function listBranches(repo: string, prefix: string): Promise<string[]> {
  const r = await runGit(["-C", repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`], { allowFail: true });
  return r.stdout.split("\n").filter(Boolean);
}

export type WorktreeEntry = { path: string; head: string | null; branch: string | null; locked: boolean };

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await runGit(["-C", repo, "worktree", "list", "--porcelain"], { allowFail: true });
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, locked: false };
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line.startsWith("locked")) cur.locked = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** 本体の状態（テストと記録用）: HEAD・チェックアウト中のブランチ・作業ツリーの変更 */
export async function repoSnapshot(repo: string): Promise<{ head: string; branch: string; status: string; index: string }> {
  return {
    head: (await runGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim(),
    branch: (await runGit(["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).stdout.trim(),
    status: (await runGit(["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"])).stdout,
    index: (await runGit(["-C", repo, "diff", "--cached", "--name-status"])).stdout,
  };
}

/**
 * Baton の worktree の管理フォルダ（<repo>/.git/worktrees/<name>/）にある、古い index.lock を消す（D-83）。
 * 本体の .git/index.lock には触らない。git が動いていれば何もしない。
 */
export async function cleanStaleWorktreeLocks(repo: string, worktreesRoot: string, olderThanMs: number, now = Date.now()): Promise<string[]> {
  const commonDir = (await runGit(["-C", repo, "rev-parse", "--git-common-dir"], { allowFail: true })).stdout.trim();
  if (!commonDir) return [];
  const common = path.resolve(repo, commonDir);
  const gitRunning = (await new Promise<boolean>((resolve) => execFile("pgrep", ["-x", "git"], (err) => resolve(!err))));
  if (gitRunning) return [];
  const removed: string[] = [];
  const root = await realpath(worktreesRoot).catch(() => path.resolve(worktreesRoot));
  for (const name of await readdir(path.join(common, "worktrees")).catch(() => [] as string[])) {
    const admin = path.join(common, "worktrees", name);
    const gitdirFile = await readFile(path.join(admin, "gitdir"), "utf8").catch(() => "");
    const wt = path.dirname(gitdirFile.trim());
    const rel = path.relative(root, wt);
    if (!wt || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const lock = path.join(admin, "index.lock");
    const st = await stat(lock).catch(() => null);
    if (st && now - st.mtimeMs >= olderThanMs) {
      await rm(lock, { force: true });
      removed.push(lock);
    }
  }
  return removed;
}
