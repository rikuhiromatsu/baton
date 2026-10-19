// 作業フォルダの外に出さないためのパス検査（設計書 5.5）。
// 1. NUL・絶対パス・`..`・`.baton`（退避先）を最初に拒否
// 2. path.resolve した先を fs.realpath で実体にし、作業フォルダの実体の配下でなければ拒否（シンボリックリンクでの脱出を防ぐ）
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

/** ランナーが内部で使うフォルダ（上書き前の退避など）。メンバーは触れない */
export const INTERNAL_DIR = ".baton";

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 文字列だけで分かる危険を拒否し、正規化した相対パス（区切りは /）を返す */
export function normalizeRelPath(input: unknown, opts: { allowRoot?: boolean } = {}): string {
  if (typeof input !== "string") throw new PathGuardError("path は文字列で指定してください");
  if (input.includes("\0")) throw new PathGuardError("path に NUL 文字は使えません");
  const p = input.replace(/\\/g, "/").trim();
  if (p.startsWith("/") || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith("~")) {
    throw new PathGuardError("絶対パスは使えません。作業フォルダからの相対パスで指定してください");
  }
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) throw new PathGuardError("`..` は使えません");
  if (parts[0] === INTERNAL_DIR) throw new PathGuardError(`${INTERNAL_DIR} はランナー専用のフォルダです`);
  if (parts.length === 0 && !opts.allowRoot) throw new PathGuardError("ファイルのパスを指定してください");
  return parts.join("/");
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export type ResolvedPath = {
  /** 作業フォルダの実体（realpath） */
  rootReal: string;
  /** 対象の絶対パス（実体。存在しない場合は存在する祖先の実体＋残り） */
  abs: string;
  /** 作業フォルダからの相対パス（/ 区切り） */
  rel: string;
  exists: boolean;
};

/**
 * 作業フォルダ root の中の rel を解決する。
 * 存在するものは realpath で実体を取り、配下でなければ拒否。
 * 存在しないもの（これから書くファイル）は、存在する一番近い祖先の実体が配下であることを確かめる。
 * 宛先が壊れたシンボリックリンクのときも拒否する（書き込みでリンク先に作られてしまうため）。
 */
export async function resolveInWorkspace(root: string, relInput: unknown, opts: { allowRoot?: boolean } = {}): Promise<ResolvedPath> {
  const rel = normalizeRelPath(relInput, opts);
  const rootReal = await realpath(root);
  const target = path.resolve(rootReal, rel);
  if (!isInside(rootReal, target)) throw new PathGuardError("作業フォルダの外は指定できません");

  if (await exists(target)) {
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new PathGuardError("リンク先が存在しないシンボリックリンクは使えません");
    }
    if (!isInside(rootReal, real)) throw new PathGuardError("作業フォルダの外を指すシンボリックリンクは使えません");
    return { rootReal, abs: real, rel, exists: true };
  }

  // 存在しない: 祖先をたどる
  let cur = path.dirname(target);
  const rest: string[] = [path.basename(target)];
  while (!(await exists(cur))) {
    rest.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let ancestorReal: string;
  try {
    ancestorReal = await realpath(cur);
  } catch {
    throw new PathGuardError("リンク先が存在しないシンボリックリンクは使えません");
  }
  if (!isInside(rootReal, ancestorReal)) throw new PathGuardError("作業フォルダの外を指すシンボリックリンクは使えません");
  return { rootReal, abs: path.join(ancestorReal, ...rest), rel, exists: false };
}

/** abs が root の実体の配下にあるか（書き込み直前の再確認用） */
export async function assertInside(rootReal: string, abs: string): Promise<void> {
  const real = await realpath(abs);
  if (!isInside(rootReal, real)) throw new PathGuardError("作業フォルダの外は指定できません");
}

export function isInsideDir(root: string, target: string): boolean {
  return isInside(root, target);
}
