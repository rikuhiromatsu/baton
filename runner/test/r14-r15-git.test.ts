// R14 git（既存リポジトリ。7.3〜7.5・D-50）: 未コミットの変更・失敗するフック・別のブランチをチェックアウト中の本体が変わらない。
// 確定で取り込まず push もせず、baton/<id8>/integration だけが残る。シナリオ B3（propose_project → 立てる → 仕事 → 承認）。
// R15 git（Baton 専用）: git init -b main と初期コミット、確定で main に --no-ff、worktree と baton/* を消す。
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { repoSnapshot } from "../src/git/git.ts";
import { git, makeEnv, makeSampleRepo, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R14 既存リポジトリ", () => {
  it("B3: 案 → 立てる → 仕事 → 承認。本体の HEAD・ブランチ・作業ツリー・index が変わらず、統合用ブランチだけ残る", async () => {
    env = await makeEnv();
    const repo = await makeSampleRepo(path.join(env.home, "projects"));
    // 別のブランチをチェックアウト中、未コミットの変更と index、失敗するフック
    git(repo, "checkout", "-q", "-b", "feature/owner");
    await writeFile(path.join(repo, "README.md"), "# sample\n作業中\n");
    await writeFile(path.join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "staged.txt");
    await writeFile(path.join(repo, "untracked.txt"), "u\n");
    for (const h of ["pre-commit", "post-checkout", "pre-merge-commit", "commit-msg", "post-merge"]) {
      await writeFile(path.join(repo, ".git/hooks", h), "#!/bin/sh\necho hook-ran >> \"$(git rev-parse --git-common-dir)/hook.log\"\nexit 1\n");
      await chmod(path.join(repo, ".git/hooks", h), 0o755);
    }
    const before = await repoSnapshot(repo);
    const refsBefore = git(repo, "for-each-ref", "--format=%(refname)");
    process.env.FAKE_CLAUDE_REPO_PATH = repo;
    env.api.repos = [{ path: repo, name: "sample-repo", defaultBranch: "main", headSha: null, lastCommitAt: null, dirty: true, projectId: null, seenAt: 0 }];

    env.api.ceoSays(COO_THREAD_ID, "[propose] [repo] サンプルに機能を足して");
    await env.step();
    const proposal = env.api.proposals[0]!;
    expect(proposal.workspace).toMatchObject({ kind: "repo", repoPath: repo });
    expect(env.api.agentMessages(COO_THREAD_ID).at(-1)!.kind).toBe("project_proposal");
    env.api.acceptProposal(proposal.id);
    // 立った知らせ（id 付き）→ COO が existing で delegate → リーダー → メンバー → 報告
    for (let i = 0; i < 12 && [...env.api.instructions.values()][0]?.status !== "review"; i++) await env.step();
    const instr = [...env.api.instructions.values()][0]!;
    expect(instr.status).toBe("review");
    expect(env.api.transcript.some((t) => t.kind === "user" && String((t.body as { text?: string }).text).includes(`id: ${proposal.projectId}`))).toBe(true);
    const short = instr.id.replace(/-/g, "").slice(0, 8);
    expect(git(repo, "branch", "--list", `baton/${short}/*`)).toContain(`baton/${short}/integration`);
    // 統合用は main から（本体のチェックアウト中のブランチではない）
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(integration.baseRef).toBe("main");
    expect(integration.baseSha).toBe(git(repo, "rev-parse", "main"));
    expect(git(integration.worktreePath, "log", "-1", "--format=%an")).toBe("Baton");

    env.api.approve(instr.id);
    await env.drain();
    expect(env.api.finalizedLog[0]!.input).toMatchObject({ outcome: "kept", branch: `baton/${short}/integration` });
    const after = await repoSnapshot(repo);
    expect(after).toEqual(before);
    // 残るのは統合用ブランチだけ（タスク用は消す）、remote は増えない
    expect(git(repo, "branch", "--list", `baton/${short}/*`).replace(/^[ *+]+/gm, "").split("\n")).toEqual([`baton/${short}/integration`]);
    expect(git(repo, "remote")).toBe("");
    const refsAfter = git(repo, "for-each-ref", "--format=%(refname)");
    expect(refsAfter.split("\n").filter((r) => !refsBefore.split("\n").includes(r))).toEqual([`refs/heads/baton/${short}/integration`]);
    expect(existsSync(integration.worktreePath)).toBe(false);
    // フックは一度も動いていない
    expect(existsSync(path.join(repo, ".git/hook.log"))).toBe(false);
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# sample\n作業中\n");
    const ws = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(ws.status).toBe("kept");
    expect(ws.finalizedAt).not.toBeNull();
    delete process.env.FAKE_CLAUDE_REPO_PATH;
  }, 60_000);

  it("候補に無い repoPath の propose_project は Baton 専用に直す", async () => {
    env = await makeEnv();
    process.env.FAKE_CLAUDE_REPO_PATH = "/etc";
    env.api.ceoSays(COO_THREAD_ID, "[propose] [repo] 何か");
    await env.step();
    expect(env.api.proposals[0]!.workspace).toEqual({ kind: "baton" });
    delete process.env.FAKE_CLAUDE_REPO_PATH;
  }, 30_000);
});

describe("R15 Baton 専用", () => {
  it("git init -b main と初期コミット（.baton/history/ は .gitignore）。確定で main に --no-ff、worktree と baton/* を消す", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await env.drain();
    const project = [...env.api.projects.values()][0]!;
    const body = path.join(env.dataDir, "projects", project.slug);
    expect(git(body, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(body, "log", "--format=%s", "main")).toBe("Baton: 初期コミット");
    expect(await readFile(path.join(body, ".gitignore"), "utf8")).toContain(".baton/history/");
    const instr = [...env.api.instructions.values()][0]!;
    expect(instr.status).toBe("review");
    env.api.approve(instr.id);
    await env.drain();
    expect(env.api.finalizedLog[0]!.input.outcome).toBe("merged");
    const subjects = git(body, "log", "--format=%s", "main").split("\n");
    expect(subjects[0]).toMatch(/^Merge branch 'baton\/.+\/integration'/);
    expect(git(body, "branch", "--list", "baton/*")).toBe("");
    expect(git(body, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(body, "status", "--porcelain")).toBe("");
  }, 60_000);
});
