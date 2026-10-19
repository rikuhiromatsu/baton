// R1 パス検査: `..`、絶対パス、シンボリックリンクで外に出る、NUL を拒否。作業フォルダ内は通る。
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathGuardError, resolveInWorkspace } from "../src/tools/path-guard.ts";
import { tempDir } from "./helpers.ts";

describe("R1 パス検査", () => {
  let base: string;
  let root: string;
  let outside: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await tempDir();
    base = t.dir;
    cleanup = t.cleanup;
    root = path.join(base, "projects", "demo");
    outside = path.join(base, "secret");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "token.txt"), "secret");
    await writeFile(path.join(root, "docs", "a.md"), "a");
  });
  afterEach(() => cleanup());

  it.each([
    ["..", "../secret/token.txt"],
    ["途中の ..", "docs/../../secret/token.txt"],
    ["絶対パス", "/etc/passwd"],
    ["絶対パス（作業フォルダ自身）", "/tmp/x"],
    ["ホーム", "~/x"],
    ["NUL", "docs/a.md\0.txt"],
    ["Windows 形式", "C:\\x"],
    ["内部フォルダ", ".baton/history/a"],
    ["空", ""],
  ])("%s を拒否する", async (_name, p) => {
    await expect(resolveInWorkspace(root, p)).rejects.toBeInstanceOf(PathGuardError);
  });

  it("文字列でない path を拒否する", async () => {
    await expect(resolveInWorkspace(root, 123)).rejects.toBeInstanceOf(PathGuardError);
  });

  it("外を指すシンボリックリンク（ファイル）を拒否する", async () => {
    await symlink(path.join(outside, "token.txt"), path.join(root, "link.txt"));
    await expect(resolveInWorkspace(root, "link.txt")).rejects.toBeInstanceOf(PathGuardError);
  });

  it("外を指すシンボリックリンク（フォルダ）の下も拒否する（まだ無いファイルでも）", async () => {
    await symlink(outside, path.join(root, "out"));
    await expect(resolveInWorkspace(root, "out/token.txt")).rejects.toBeInstanceOf(PathGuardError);
    await expect(resolveInWorkspace(root, "out/new/file.md")).rejects.toBeInstanceOf(PathGuardError);
  });

  it("リンク先の無いシンボリックリンクを拒否する（書き込みで外に作られないように）", async () => {
    await symlink(path.join(outside, "not-yet.txt"), path.join(root, "dangling.txt"));
    await expect(resolveInWorkspace(root, "dangling.txt")).rejects.toBeInstanceOf(PathGuardError);
  });

  it("作業フォルダ内は通る（既存・新規・中のリンク）", async () => {
    const a = await resolveInWorkspace(root, "docs/a.md");
    expect(a.exists).toBe(true);
    expect(a.rel).toBe("docs/a.md");
    const b = await resolveInWorkspace(root, "./new/dir/b.md");
    expect(b.exists).toBe(false);
    expect(b.rel).toBe("new/dir/b.md");
    expect(b.abs.endsWith(path.join("new", "dir", "b.md"))).toBe(true);
    await symlink(path.join(root, "docs"), path.join(root, "docs-link"));
    const c = await resolveInWorkspace(root, "docs-link/a.md");
    expect(c.exists).toBe(true);
  });

  it("作業フォルダ自体がシンボリックリンクでも、その実体の中は通る", async () => {
    const linkRoot = path.join(base, "root-link");
    await symlink(root, linkRoot);
    const r = await resolveInWorkspace(linkRoot, "docs/a.md");
    expect(r.exists).toBe(true);
  });
});
