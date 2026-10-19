// R2 fs_write の大きさ・個数・合計の上限、上書き前の退避。
import { readFile, readdir, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultLimits } from "../src/config.ts";
import { FsTools, ToolInputError, WriteCounters, listWorkspace } from "../src/tools/fs.ts";
import { PathGuardError } from "../src/tools/path-guard.ts";
import { tempDir } from "./helpers.ts";

describe("R2 fs の道具", () => {
  let root: string;
  let base: string;
  let cleanup: () => Promise<void>;
  let now = 1_700_000_000_000;

  beforeEach(async () => {
    const t = await tempDir();
    base = t.dir;
    cleanup = t.cleanup;
    root = path.join(base, "projects", "demo");
    await mkdir(root, { recursive: true });
  });
  afterEach(() => cleanup());

  const tools = (over: Partial<ReturnType<typeof defaultLimits>> = {}, counters = new WriteCounters()) =>
    new FsTools({ root, limits: { ...defaultLimits(), ...over }, counters, now: () => now++ });

  it("書いて読める。親フォルダは自動で作る", async () => {
    const fs = tools();
    const w = await fs.fsWrite({ path: "a/b/c.md", content: "こんにちは" });
    expect(w.ok).toBe(true);
    expect(await readFile(path.join(root, "a/b/c.md"), "utf8")).toBe("こんにちは");
    const r = await fs.fsRead({ path: "a/b/c.md" });
    expect(r.text).toBe("こんにちは");
  });

  it("1 ファイルの大きさの上限（1MB）を超えると拒否、追記で超える場合も拒否", async () => {
    const fs = tools({ fsWriteMaxBytes: 10 });
    await expect(fs.fsWrite({ path: "big.txt", content: "x".repeat(11) })).rejects.toBeInstanceOf(ToolInputError);
    await fs.fsWrite({ path: "ok.txt", content: "x".repeat(8) });
    await expect(fs.fsAppend({ path: "ok.txt", content: "yyy" })).rejects.toBeInstanceOf(ToolInputError);
    await fs.fsAppend({ path: "ok.txt", content: "yy" });
    expect(await readFile(path.join(root, "ok.txt"), "utf8")).toBe("xxxxxxxxyy");
  });

  it("既定の上限は 1MB（マルチバイトはバイトで数える）", async () => {
    const fs = tools();
    await expect(fs.fsWrite({ path: "big.txt", content: "あ".repeat(350_000) })).rejects.toThrow(/1048576/);
  });

  it("1 指示あたりのファイル数の上限（同じファイルへの書き直しは数えない）", async () => {
    const counters = new WriteCounters();
    const fs = tools({ fsWritesPerInstruction: 2 }, counters);
    await fs.fsWrite({ path: "1.txt", content: "a" });
    await fs.fsWrite({ path: "2.txt", content: "a" });
    await fs.fsWrite({ path: "1.txt", content: "b" });
    await expect(fs.fsWrite({ path: "3.txt", content: "a" })).rejects.toThrow(/2 個まで/);
    // 同じ指示の別のメンバー（同じカウンタ）でも数える
    const fs2 = tools({ fsWritesPerInstruction: 2 }, counters);
    await expect(fs2.fsWrite({ path: "4.txt", content: "a" })).rejects.toThrow(/2 個まで/);
  });

  it("1 指示あたりの合計の上限", async () => {
    const fs = tools({ fsWriteTotalBytesPerInstruction: 10 });
    await fs.fsWrite({ path: "1.txt", content: "12345" });
    await fs.fsAppend({ path: "1.txt", content: "1234" });
    await expect(fs.fsWrite({ path: "2.txt", content: "12" })).rejects.toThrow(/合計 10 バイト/);
  });

  it("上書き前の内容を .baton/history/ に退避する", async () => {
    const fs = tools();
    await fs.fsWrite({ path: "notes/a.md", content: "v1" });
    await fs.fsWrite({ path: "notes/a.md", content: "v2" });
    await fs.fsWrite({ path: "notes/a.md", content: "v3" });
    expect(await readFile(path.join(root, "notes/a.md"), "utf8")).toBe("v3");
    const hist = path.join(root, ".baton/history/notes");
    const files = (await readdir(hist)).sort();
    expect(files).toHaveLength(2);
    const contents = await Promise.all(files.map((f) => readFile(path.join(hist, f), "utf8")));
    expect(contents.sort()).toEqual(["v1", "v2"]);
  });

  it("退避フォルダは一覧に出ず、メンバーは読めも書けもしない", async () => {
    const fs = tools();
    await fs.fsWrite({ path: "a.md", content: "v1" });
    await fs.fsWrite({ path: "a.md", content: "v2" });
    const { entries } = await listWorkspace(root, "", 500);
    expect(entries.map((e) => e.path)).toEqual(["a.md"]);
    await expect(fs.fsRead({ path: ".baton/history/a.md.1" })).rejects.toBeInstanceOf(PathGuardError);
    await expect(fs.fsWrite({ path: ".baton/x", content: "x" })).rejects.toBeInstanceOf(PathGuardError);
  });

  it("外を指すシンボリックリンクには書かない", async () => {
    const outside = path.join(base, "outside.txt");
    await writeFile(outside, "original");
    await symlink(outside, path.join(root, "evil.txt"));
    const fs = tools();
    await expect(fs.fsWrite({ path: "evil.txt", content: "pwned" })).rejects.toBeInstanceOf(PathGuardError);
    expect(await readFile(outside, "utf8")).toBe("original");
  });

  it("fs_read は 20,000 文字までで、続きは offset で読める。バイナリは読まない", async () => {
    const fs = tools({ fsReadMaxChars: 5 });
    await fs.fsWrite({ path: "a.txt", content: "0123456789" });
    const r1 = await fs.fsRead({ path: "a.txt" });
    expect(r1.text.startsWith("01234")).toBe(true);
    expect(r1.text).toMatch(/offset=5/);
    const r2 = await fs.fsRead({ path: "a.txt", offset: 5, maxChars: 100 });
    expect(r2.text).toBe("56789");
    await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    await expect(fs.fsRead({ path: "bin.dat" })).rejects.toThrow(/テキスト/);
  });

  it("fs_list は隠しファイルを出さず、上限で打ち切る", async () => {
    const fs = tools({ fsListMax: 2 });
    await fs.fsWrite({ path: ".hidden", content: "x" }).catch(() => undefined);
    await writeFile(path.join(root, ".secret"), "x");
    await fs.fsWrite({ path: "a.md", content: "x" });
    await fs.fsWrite({ path: "b.md", content: "x" });
    await fs.fsWrite({ path: "c.md", content: "x" });
    const r = await fs.fsList({});
    expect(r.text).not.toMatch(/secret|hidden/);
    expect(r.text).toMatch(/打ち切り/);
  });
});
