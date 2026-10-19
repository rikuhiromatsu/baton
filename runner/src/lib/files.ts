// tailnet の /files 用の小さな道具（v1 の tools/fs.ts から、読み取りの部分だけを残した）。
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace } from "./path-guard.ts";

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
      } else if (st.isFile()) {
        entries.push({ path: rel, type: "file", size: st.size });
      }
    }
  };
  const st = await stat(base.abs).catch(() => null);
  if (!st?.isDirectory()) throw new NotFoundError(`見つかりません: ${base.rel || "."}`);
  await walk(base.abs, base.rel);
  return { entries, truncated };
}
