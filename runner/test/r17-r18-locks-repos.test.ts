// R17 ロックと引き継ぎ（7.5・D-83）: 本体ごとに git 操作を直列、ロックの失敗は 3 回やり直す、Baton の worktree の古い index.lock だけ消す、
// 再起動で D1 と git worktree list を突き合わせ（D1 にあってフォルダが無ければ作り直す、知らないものは触らない）。消すのは worktrees の配下だけ。
// R18 リポジトリの走査（3.2）: ~/projects/*/ と */*/ の .git、Baton 自身・node_modules・外へのシンボリックリンク・worktree を除く。
import { existsSync } from "node:fs";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GitError, addWorktree, assertUnderWorktrees, cleanStaleWorktreeLocks, retryOnLock, withRepoLock } from "../src/git/git.ts";
import { scanRepos } from "../src/git/repos.ts";
import { reconcileWorkspaces } from "../src/startup.ts";
import { git, makeEnv, makeSampleRepo, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R17 ロックと引き継ぎ", () => {
  it("同じ本体の操作は直列、別の本体は並行", async () => {
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
    };
    await Promise.all([withRepoLock("/tmp/repo-a", job("a1", 30)), withRepoLock("/tmp/repo-a", job("a2", 5)), withRepoLock("/tmp/repo-b", job("b1", 5))]);
    // a1 と a2 は重ならない（どちらかが終わってから次が始まる）
    const [i1s, i1e, i2s, i2e] = ["a1+", "a1-", "a2+", "a2-"].map((x) => order.indexOf(x)) as [number, number, number, number];
    expect(i1e < i2s || i2e < i1s).toBe(true);
    // 別の本体の b1 は a の終わりを待たない
    expect(order.indexOf("b1-")).toBeLessThan(order.length - 1);
  });

  it("index.lock の失敗だけ 3 回までやり直す", async () => {
    let n = 0;
    await expect(
      retryOnLock(async () => {
        n++;
        if (n < 3) throw new GitError("lock", 128, "fatal: Unable to create '/x/.git/index.lock': File exists.");
        return "ok";
      }, [1, 1, 1]),
    ).resolves.toBe("ok");
    n = 0;
    await expect(
      retryOnLock(async () => {
        n++;
        throw new GitError("other", 1, "fatal: bad");
      }, [1, 1, 1]),
    ).rejects.toThrow("other");
    expect(n).toBe(1);
  });

  it("再起動: D1 にあってフォルダが無い worktree はブランチから作り直し、知らない worktree と本体の index.lock には触らない。古い Baton の index.lock は消す", async () => {
    env = await makeEnv();
    const repo = await makeSampleRepo(path.join(env.home, "projects"));
    const wt = path.join(env.dataDir, "worktrees/abcd1234/app/t1-r1");
    const sha = git(repo, "rev-parse", "HEAD");
    await addWorktree({ repo, dir: wt, branch: "baton/abcd1234/t1-r1", startSha: sha, reason: "baton test" });
    const unknown = path.join(env.dataDir, "worktrees/zzzz0000/app/t9-r1");
    await addWorktree({ repo, dir: unknown, branch: "baton/zzzz0000/t9-r1", startSha: sha, reason: "baton other" });
    // D1 の行（フォルダは消えた）
    const ws = await env.api.createWorkspace({
      id: randomUUID(),
      instructionId: "abcd1234-0000-4000-8000-000000000000",
      projectId: "p",
      purpose: "task",
      taskId: null,
      parentId: null,
      kind: "repo",
      repoPath: repo,
      worktreePath: wt,
      branch: "baton/abcd1234/t1-r1",
      baseRef: "main",
      baseSha: sha,
    });
    git(repo, "worktree", "unlock", wt);
    git(repo, "worktree", "remove", "--force", wt);
    expect(existsSync(wt)).toBe(false);
    // 古い index.lock（Baton の worktree の管理フォルダ）と本体の index.lock
    const admin = path.join(repo, ".git/worktrees", path.basename(unknown));
    await writeFile(path.join(admin, "index.lock"), "");
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(path.join(admin, "index.lock"), old, old);
    await writeFile(path.join(repo, ".git/index.lock"), "");
    await utimes(path.join(repo, ".git/index.lock"), old, old);

    const r = await reconcileWorkspaces(env.ctx);
    expect(r.restored).toEqual([wt]);
    expect(existsSync(path.join(wt, "README.md"))).toBe(true);
    expect(r.unknown).toEqual([unknown]);
    expect(existsSync(unknown)).toBe(true);
    expect(r.locksRemoved).toEqual([path.join(admin, "index.lock")]);
    expect(existsSync(path.join(repo, ".git/index.lock"))).toBe(true);
    expect(ws.status).toBe("active");
    // 本人の git worktree prune で消えないようにロックされている
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked");
    await expect(cleanStaleWorktreeLocks(repo, path.join(env.dataDir, "worktrees"), 0)).resolves.toEqual([]);
  }, 30_000);

  it("worktrees の外は消さない", async () => {
    env = await makeEnv();
    await expect(assertUnderWorktrees(path.join(env.dataDir, "worktrees"), env.home)).rejects.toThrow(/外は消せません/);
    await expect(assertUnderWorktrees(path.join(env.dataDir, "worktrees"), path.join(env.dataDir, "worktrees"))).rejects.toThrow();
    await expect(assertUnderWorktrees(path.join(env.dataDir, "worktrees"), path.join(env.dataDir, "worktrees/a/b"))).resolves.toBeUndefined();
  });
});

describe("R18 リポジトリの走査", () => {
  it("~/projects/*/ と */*/ の .git を拾い、Baton 自身・node_modules・外へのリンク・worktree を除く", async () => {
    env = await makeEnv();
    const root = path.join(env.home, "projects");
    const a = await makeSampleRepo(root, "solo");
    await mkdir(path.join(root, "owner"), { recursive: true });
    const b = await makeSampleRepo(path.join(root, "owner"), "app");
    const self = await makeSampleRepo(path.join(root, "owner"), "baton");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await makeSampleRepo(path.join(root, "node_modules"), "pkg");
    const outside = await makeSampleRepo(env.dir, "outside");
    await symlink(outside, path.join(root, "link-out"));
    git(b, "worktree", "add", "-q", path.join(root, "owner/app-wt"), "-b", "wt");
    await writeFile(path.join(b, "README.md"), "dirty\n");
    const items = await scanRepos({ root, exclude: [self] });
    expect(items.map((i) => i.name).sort()).toEqual(["owner/app", "solo"]);
    const app = items.find((i) => i.name === "owner/app")!;
    expect(app).toMatchObject({ path: b, defaultBranch: "main", dirty: true });
    expect(app.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(items.find((i) => i.path === a)!.dirty).toBe(false);
  }, 30_000);
});
