// メンバーのファイル道具（設計書 5.5）: fs_list / fs_read / fs_write / fs_append。
// すべて作業フォルダ ~/baton-data/projects/<slug>/ の中だけ。削除・移動は無い。上書き前の内容は .baton/history/ に退避。
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { INTERNAL_DIR, PathGuardError, assertInside, resolveInWorkspace } from "./path-guard.ts";

export type ToolResult = {
  ok: boolean;
  /** モデルに返す本文 */
  text: string;
  /** 古いターンを圧縮するときの 1 行要約 */
  short: string;
};

export type FsLimits = {
  fsReadMaxChars: number;
  fsListMax: number;
  fsWriteMaxBytes: number;
  fsWritesPerInstruction: number;
  fsWriteTotalBytesPerInstruction: number;
};

/** 1 指示（1 回の実行）あたりの書き込みの集計 */
export class WriteCounters {
  readonly paths = new Set<string>();
  totalBytes = 0;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

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

export function mimeFor(relPath: string, sample?: Buffer): string {
  const m = MIME_BY_EXT[path.extname(relPath).toLowerCase()];
  if (m) return m;
  if (sample && looksLikeText(sample)) return "text/plain";
  return "application/octet-stream";
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "image/svg+xml";
}

export function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

export type ListEntry = { path: string; type: "file" | "dir"; size: number };

/**
 * 作業フォルダ内を再帰的に一覧する（隠しファイル・隠しフォルダは出さない。シンボリックリンクはたどらない）。
 */
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
  if (!st) throw new ToolInputError(`見つかりません: ${base.rel || "."}`);
  if (!st.isDirectory()) throw new ToolInputError(`フォルダではありません: ${base.rel}`);
  await walk(base.abs, base.rel);
  return { entries, truncated };
}

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${key} がありません`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolInputError(`${key} は文字列で指定してください`);
  return v;
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new ToolInputError(`${key} は 0 以上の数値で指定してください`);
  return Math.floor(n);
}

export class FsTools {
  private readonly root: string;
  private readonly limits: FsLimits;
  private readonly counters: WriteCounters;
  private readonly now: () => number;

  constructor(opts: { root: string; limits: FsLimits; counters?: WriteCounters; now?: () => number }) {
    this.root = opts.root;
    this.limits = opts.limits;
    this.counters = opts.counters ?? new WriteCounters();
    this.now = opts.now ?? Date.now;
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async fsList(args: Record<string, unknown>): Promise<ToolResult> {
    const sub = str(args, "path", false) ?? "";
    const { entries, truncated } = await listWorkspace(this.root, sub, this.limits.fsListMax);
    const lines = entries.map((e) => (e.type === "dir" ? e.path : `${e.path}（${e.size} バイト）`));
    const text = (lines.length ? lines.join("\n") : "（空です）") + (truncated ? `\n…（${this.limits.fsListMax} 件で打ち切り）` : "");
    return { ok: true, text, short: `${sub || "."} の一覧 ${entries.length} 件` };
  }

  async fsRead(args: Record<string, unknown>): Promise<ToolResult> {
    const p = await resolveInWorkspace(this.root, str(args, "path", true));
    if (!p.exists) throw new ToolInputError(`見つかりません: ${p.rel}`);
    const st = await stat(p.abs);
    if (!st.isFile()) throw new ToolInputError(`ファイルではありません: ${p.rel}`);
    if (st.size > 16 * 1024 * 1024) throw new ToolInputError(`大きすぎて読めません（${st.size} バイト）`);
    const buf = await readFile(p.abs);
    if (!looksLikeText(buf)) throw new ToolInputError(`テキスト（UTF-8）ではありません: ${p.rel}`);
    const all = buf.toString("utf8");
    const offset = int(args, "offset") ?? 0;
    const maxChars = Math.min(int(args, "maxChars") ?? this.limits.fsReadMaxChars, this.limits.fsReadMaxChars);
    const part = all.slice(offset, offset + maxChars);
    const end = offset + part.length;
    const more = end < all.length ? `\n…（全 ${all.length} 文字中 ${offset}〜${end}。続きは offset=${end}）` : "";
    return { ok: true, text: part + more, short: `${p.rel} を読んだ（${part.length} 文字）` };
  }

  async fsWrite(args: Record<string, unknown>): Promise<ToolResult> {
    return this.write(args, "write");
  }

  async fsAppend(args: Record<string, unknown>): Promise<ToolResult> {
    return this.write(args, "append");
  }

  private async write(args: Record<string, unknown>, mode: "write" | "append"): Promise<ToolResult> {
    const content = str(args, "content", true);
    const p = await resolveInWorkspace(this.root, str(args, "path", true));
    const bytes = Buffer.byteLength(content, "utf8");

    let currentSize = 0;
    if (p.exists) {
      const st = await lstat(p.abs);
      if (!st.isFile()) throw new ToolInputError(`ファイルではありません: ${p.rel}`);
      currentSize = st.size;
    }
    const finalSize = mode === "append" ? currentSize + bytes : bytes;
    if (finalSize > this.limits.fsWriteMaxBytes) {
      throw new ToolInputError(`1 ファイルは ${this.limits.fsWriteMaxBytes} バイトまでです（${finalSize} バイトになります）`);
    }
    const isNewPath = !this.counters.paths.has(p.rel);
    if (isNewPath && this.counters.paths.size >= this.limits.fsWritesPerInstruction) {
      throw new ToolInputError(`1 つの指示で書けるファイルは ${this.limits.fsWritesPerInstruction} 個までです`);
    }
    if (this.counters.totalBytes + bytes > this.limits.fsWriteTotalBytesPerInstruction) {
      throw new ToolInputError(`1 つの指示で書ける量は合計 ${this.limits.fsWriteTotalBytesPerInstruction} バイトまでです`);
    }

    // 親フォルダを作り、作ったあとにもう一度配下であることを確かめる
    const parent = path.dirname(p.abs);
    await mkdir(parent, { recursive: true });
    await assertInside(p.rootReal, parent);

    if (mode === "write" && p.exists && currentSize > 0) await this.backup(p.rootReal, p.abs, p.rel);

    const flags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (mode === "append" ? constants.O_APPEND : constants.O_TRUNC);
    const fh = await open(p.abs, flags, 0o644);
    try {
      await fh.writeFile(content, "utf8");
    } finally {
      await fh.close();
    }
    this.counters.paths.add(p.rel);
    this.counters.totalBytes += bytes;
    const verb = mode === "append" ? "追記" : "書き込み";
    return { ok: true, text: `${p.rel} に ${bytes} バイト${verb}しました（ファイルは ${finalSize} バイト）`, short: `${p.rel} に ${bytes} バイト${verb}` };
  }

  /** 上書き前の内容を .baton/history/<相対パス>.<時刻> に退避 */
  private async backup(rootReal: string, abs: string, rel: string): Promise<void> {
    const dest = path.join(rootReal, INTERNAL_DIR, "history", `${rel}.${this.now()}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(abs, dest, constants.COPYFILE_EXCL).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") await copyFile(abs, `${dest}-${Math.random().toString(36).slice(2, 8)}`);
      else throw err;
    });
  }
}

/** 道具のエラーをモデルに返す文にする（指示の失敗にはしない） */
export function toolErrorResult(tool: string, err: unknown): ToolResult {
  const msg = err instanceof PathGuardError || err instanceof ToolInputError ? err.message : `失敗しました: ${(err as Error)?.message ?? String(err)}`;
  return { ok: false, text: `エラー: ${msg}`, short: `${tool} はエラー（${msg.slice(0, 60)}）` };
}
