// R26 シンボリックリンクでランナーに秘密を読ませない（Codex 指摘 critical）。
// メンバーは worktree に ~/.config/... へのリンクを置き、成果物として返せる。ランナーは Seatbelt の外で読むので、
// 成果物・CLAUDE.md・/files のどれでもリンクを辿らない。差分は git がリンクとして扱う（中身は出ない）。
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { repoRulesText } from "../src/claude/profiles.ts";
import { NotFoundError, openFileInside, readFileInside } from "../src/lib/files.ts";
import { PathGuardError } from "../src/lib/path-guard.ts";
import { makeEnv, tempDir, type Env } from "./helpers.ts";

const SECRET = "SECRET-LINEAR-API-KEY-0123456789";

let env: Env | undefined;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  for (const c of cleanups) await c();
  cleanups = [];
});

async function fixture() {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const root = path.join(t.dir, "wt");
  const outside = path.join(t.dir, "home/.config/linear");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "api-key"), SECRET);
  await writeFile(path.join(root, "docs/report.md"), "# 報告");
  await writeFile(path.join(root, "AGENTS.md"), "# 決まり");
  return { dir: t.dir, root, secretFile: path.join(outside, "api-key"), outsideDir: outside };
}

describe("R26 リンクを辿らずに開く", () => {
  it("通常のファイルは読める", async () => {
    const f = await fixture();
    const r = await readFileInside(f.root, "docs/report.md");
    expect(r.buf.toString()).toBe("# 報告");
    expect(r.rel).toBe("docs/report.md");
  });

  it("外を指すリンク・外を指すディレクトリのリンク・中を指すリンク・ハードリンクは開かない", async () => {
    const f = await fixture();
    await symlink(f.secretFile, path.join(f.root, "leak.md"));
    await symlink(f.outsideDir, path.join(f.root, "leakdir"));
    await symlink(path.join(f.root, "docs/report.md"), path.join(f.root, "inner.md"));
    await symlink(path.join(f.root, "docs"), path.join(f.root, "innerdir"));
    await link(f.secretFile, path.join(f.root, "hard.md"));
    for (const rel of ["leak.md", "leakdir/api-key", "inner.md", "innerdir/report.md", "hard.md", f.secretFile, "../home/.config/linear/api-key"]) {
      const err = await readFileInside(f.root, rel).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, rel).toBeInstanceOf(Error);
      expect(err instanceof PathGuardError || err instanceof NotFoundError, rel).toBe(true);
    }
    // 中を指すリンクだけを許す読み方（CLAUDE.md → AGENTS.md）でも、外を指すものとハードリンクは開かない
    expect((await readFileInside(f.root, "inner.md", 1024, { allowInternalLinks: true })).buf.toString()).toBe("# 報告");
    await expect(readFileInside(f.root, "leak.md", 1024, { allowInternalLinks: true })).rejects.toBeInstanceOf(PathGuardError);
    await expect(readFileInside(f.root, "hard.md", 1024, { allowInternalLinks: true })).rejects.toBeInstanceOf(PathGuardError);
  });

  it("親ディレクトリが外を指すリンクに差し替えられたら拒否する", async () => {
    const f = await fixture();
    const opened = await openFileInside(f.root, "docs/report.md");
    await opened.fh.close();
    await rename(path.join(f.root, "docs"), path.join(f.root, "docs-old"));
    await symlink(f.outsideDir, path.join(f.root, "docs"));
    await writeFile(path.join(f.outsideDir, "report.md"), SECRET);
    await expect(readFileInside(f.root, "docs/report.md")).rejects.toBeInstanceOf(PathGuardError);
  });

  it("CLAUDE.md が外を指すリンクなら、決まりの文に入れない（中を指すものは入れる）", async () => {
    const f = await fixture();
    await symlink(f.secretFile, path.join(f.root, "CLAUDE.md"));
    const text = await repoRulesText(f.root);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("# 決まり");
  });
});

describe("R26 メンバーが秘密へのリンクを成果物として返す", () => {
  it("成果物の previewText・差分・/files のどこにも秘密が出ない", async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const secretFile = path.join(t.dir, "secret/.config/linear/api-key");
    await mkdir(path.dirname(secretFile), { recursive: true });
    await writeFile(secretFile, SECRET);
    env = await makeEnv({ fakeEnv: { FAKE_SYMLINK_TARGET: secretFile } });
    env.api.ceoSays(COO_THREAD_ID, "リンクを返す [symlink]");
    await env.drain();
    const arts = env.api.artifacts;
    // 通常の成果物は登録され、リンクの 3 つは登録されない
    expect(arts.length).toBeGreaterThan(0);
    for (const a of arts) {
      expect(a.previewText ?? "").not.toContain(SECRET);
      expect(a.relPath).not.toMatch(/leak/);
      expect(a.relPath).not.toContain("api-key");
    }
    // 統合の差分はリンク先のパスまでで、中身は出ない
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration");
    expect(integration).toBeTruthy();
    expect(integration!.diffPatch ?? "").not.toContain(SECRET);
    expect(JSON.stringify(env.api.transcript)).not.toContain(SECRET);
  }, 60_000);
});
