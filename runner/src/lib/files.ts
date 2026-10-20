// tailnet の /files 用の小さな道具（v1 の tools/fs.ts から、読み取りの部分だけを残した）。
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PathGuardError, isInsideDir, resolveInWorkspace } from "./path-guard.ts";

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".py": "text/plain",
  ".sh": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

export function mimeFor(relPath: string, sample?: Buffer): string {
  const m = MIME_BY_EXT[path.extname(relPath).toLowerCase()];
  if (m) return m;
  if (sample && looksLikeText(sample)) return "text/plain";
  return "application/octet-stream";
}

export type ListEntry = { path: string; type: "file" | "dir"; size: number };

export class NotFoundError extends Error {}

export async function listWorkspace(root: string, sub: string, max: number): Promise<{ entries: ListEntry[]; truncated: boolean }> {
  const base = await resolveInWorkspace(root, sub, { allowRoot: true });
  const entries: ListEntry[] = [];
  let truncated = false;
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(absDir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (entries.length >= max) {
        truncated = true;
        return;
      }
      const abs = path.join(absDir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = await lstat(abs).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        entries.push({ path: rel + "/", type: "dir", size: 0 });
        await walk(abs, rel);
        if (truncated) return;
      } else if (st.isFile() && st.nlink === 1) {
        // ハードリンクのあるファイルは開かないので一覧にも出さない
        entries.push({ path: rel, type: "file", size: st.size });
      }
    }
  };
  const st = await stat(base.abs).catch(() => null);
  if (!st?.isDirectory()) throw new NotFoundError(`見つかりません: ${base.rel || "."}`);
  await walk(base.abs, base.rel);
  return { entries, truncated };
}

export type OpenedFile = {
  fh: FileHandle;
  /** 開いたファイルの fstat */
  st: Stats;
  /** 作業フォルダからの相対パス（/ 区切り） */
  rel: string;
};

/**
 * 作業フォルダ root の中のファイルを、リンクを辿らずに開く（成果物・/files・CLAUDE.md の読み取り。Codex 指摘 critical）。
 * メンバーは worktree に ~/.config/... などへのシンボリックリンクを置ける。読むのは Seatbelt の外のランナーなので、
 * 1. 字句上のパスの最後がシンボリックリンクなら拒否（中を指すリンクも成果物としては扱わない）
 * 2. realpath が root の実体の配下であることを確かめる（途中のディレクトリのリンクでの脱出を拒否）
 * 3. O_NOFOLLOW で開き、開いた後の fstat が通常のファイル・リンク数 1 であること
 * 4. 開いた後にもう一度 realpath と stat を取り、開いたものと同じ（dev・ino）で、まだ配下にあることを確かめる
 *    （確かめてから開くまでの間に親ディレクトリをリンクに差し替える競合を防ぐ）
 */
export async function openFileInside(root: string, relInput: unknown, opts: { allowInternalLinks?: boolean } = {}): Promise<OpenedFile> {
  const p = await resolveInWorkspace(root, relInput);
  if (!p.exists) throw new NotFoundError(`見つかりません: ${p.rel}`);
  const lexical = path.join(p.rootReal, p.rel);
  const lst = await lstat(lexical).catch(() => null);
  if (!lst) throw new NotFoundError(`見つかりません: ${p.rel}`);
  // allowInternalLinks: 中を指すリンク（CLAUDE.md → AGENTS.md など）は許す。外を指すものは resolveInWorkspace が拒否済み
  if (!opts.allowInternalLinks && (lst.isSymbolicLink() || p.abs !== lexical)) throw new PathGuardError("シンボリックリンクは開けません");
  if (!opts.allowInternalLinks && !lst.isFile()) throw new NotFoundError(`ファイルではありません: ${p.rel}`);
  let fh: FileHandle;
  try {
    fh = await open(p.abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new PathGuardError("シンボリックリンクは開けません");
    throw new NotFoundError(`開けません: ${p.rel}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new NotFoundError(`ファイルではありません: ${p.rel}`);
    if (st.nlink > 1) throw new PathGuardError("ハードリンクのあるファイルは開けません");
    const again = await realpath(p.abs).catch(() => null);
    if (again !== p.abs || !isInsideDir(p.rootReal, again)) throw new PathGuardError("開く間に場所が変わりました");
    const now = await stat(again);
    if (now.dev !== st.dev || now.ino !== st.ino) throw new PathGuardError("開く間に場所が変わりました");
    return { fh, st, rel: p.rel };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

/** openFileInside で開いて全部読む（max を超えるものは読まない） */
export async function readFileInside(
  root: string,
  relInput: unknown,
  maxBytes = 50 * 1024 * 1024,
  opts: { allowInternalLinks?: boolean } = {},
): Promise<{ buf: Buffer; st: Stats; rel: string }> {
  const { fh, st, rel } = await openFileInside(root, relInput, opts);
  try {
    if (st.size > maxBytes) throw new PathGuardError(`大きすぎます: ${rel}`);
    const buf = await fh.readFile();
    return { buf, st, rel };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
