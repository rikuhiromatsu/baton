// 役割ごとのプロファイル（DESIGN-v2 6 章、D-84〜D-86）。
// - 既定は runner/profiles/profiles.json、<DATA>/config/profiles.local.json でキーごとに上書き
// - skills は ~/.claude/skills/ にあり neverSkills に無く、allowed-tools が拒否に当たらないものだけ（R23）
// - 起動のたびに <DATA>/run/profiles/<profile>/plugin/ を作り直し、スキルの実体を写す（シンボリックリンクは辿る）
// - CEO の好み: ~/.claude/CLAUDE.md の「## 見出し」単位で includeSections の本文を取り込む（起動のたびに読み直す）
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROFILE_IDS, type ProfileView } from "@baton/shared";
import { dataPaths, expandHome, type RunnerConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { COMMON_DENY, ROLE_TOOLS, deniedBy, type ClaudeRole } from "./permissions.ts";
import { BATON_NOTE, PROFILE_NOTES, roleInstructions } from "./prompts.ts";

const ProfileSchema = z.object({
  role: z.enum(["coo", "leader", "member"]),
  model: z.string().min(1),
  skills: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
  codexReview: z.boolean().optional(),
  /** スキルが通信を要るとき（6.2） */
  extraDomains: z.array(z.string()).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const ProfilesFileSchema = z.object({
  ceoStyle: z.object({ source: z.string(), includeSections: z.array(z.string()).default([]), extra: z.string().default("") }),
  profiles: z.record(z.string(), ProfileSchema),
  neverSkills: z.array(z.string()).default([]),
});
export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;

/** 上書きはキーごと（profiles のキーは中身ごと置き換え、ceoStyle・neverSkills は値ごと） */
const LocalOverrideSchema = z.object({
  ceoStyle: ProfilesFileSchema.shape.ceoStyle.partial().optional(),
  profiles: z.record(z.string(), ProfileSchema.partial()).optional(),
  neverSkills: z.array(z.string()).optional(),
});

export type ResolvedProfiles = {
  file: ProfilesFile;
  /** 検査で外したスキルなどの警告 */
  warnings: string[];
};

async function readJson(p: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`プロファイルを読めません: ${p}（${(err as Error).message}）`);
  }
}

export function skillsDir(config: Pick<RunnerConfig, "home">): string {
  return path.join(config.home, ".claude/skills");
}

/** SKILL.md の先頭の front matter から allowed-tools を読む（無ければ []） */
export function parseAllowedTools(skillMd: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!m) return [];
  const fm = m[1] ?? "";
  const line = /^allowed-tools:[ \t]*(.*)$/m.exec(fm);
  if (!line) return [];
  const value = (line[1] ?? "").trim();
  if (value.startsWith("[")) {
    try {
      return (JSON.parse(value) as unknown[]).map(String);
    } catch {
      return value.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  if (value === "") {
    // YAML の配列（- 項目）
    const after = fm.slice((line.index ?? 0) + line[0].length).split(/\r?\n/).slice(1);
    const out: string[] = [];
    for (const l of after) {
      const item = /^\s*-\s*(.+)$/.exec(l);
      if (!item) break;
      out.push((item[1] ?? "").trim().replace(/^["']|["']$/g, ""));
    }
    return out;
  }
  // 「Bash(git diff *), Read」「Read Grep」のような並び。括弧の外のカンマ（無ければ空白）で切る
  const sep = splitOutsideParens(value, ",").length > 1 ? "," : " ";
  return splitOutsideParens(value, sep).map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function splitOutsideParens(value: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** プロファイルを読み、スキルを検査する（起動時とハートビートの表示用） */
export async function loadProfiles(config: Pick<RunnerConfig, "profilesPath" | "profilesLocalPath" | "home">, log?: Logger): Promise<ResolvedProfiles> {
  const base = ProfilesFileSchema.parse(await readJson(config.profilesPath));
  const localRaw = await readJson(config.profilesLocalPath);
  const warnings: string[] = [];
  const file: ProfilesFile = structuredClone(base);
  if (localRaw !== null) {
    const local = LocalOverrideSchema.parse(localRaw);
    if (local.ceoStyle) file.ceoStyle = { ...file.ceoStyle, ...local.ceoStyle };
    if (local.neverSkills) file.neverSkills = local.neverSkills;
    for (const [k, v] of Object.entries(local.profiles ?? {})) {
      const merged = ProfileSchema.safeParse({ ...(file.profiles[k] ?? {}), ...v });
      if (merged.success) file.profiles[k] = merged.data;
      else warnings.push(`profiles.local.json の ${k} が不正なので無視しました`);
    }
  }
  const never = new Set([...file.neverSkills, ...base.neverSkills]);
  for (const [id, p] of Object.entries(file.profiles)) {
    const keep: string[] = [];
    for (const name of p.skills) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        warnings.push(`${id}: スキル名が不正なので外しました（${name}）`);
        continue;
      }
      if (never.has(name)) {
        warnings.push(`${id}: ${name} は neverSkills にあるので読み込みません`);
        continue;
      }
      const md = await readFile(path.join(skillsDir(config), name, "SKILL.md"), "utf8").catch(() => null);
      if (md === null) {
        warnings.push(`${id}: ${name} が ~/.claude/skills に無いので外しました`);
        continue;
      }
      const bad = parseAllowedTools(md)
        .map((t) => [t, deniedBy(t, COMMON_DENY)] as const)
        .filter(([, d]) => d !== null);
      if (bad.length) {
        warnings.push(`${id}: ${name} の allowed-tools が拒否に当たるので外しました（${bad.map(([t]) => t).join(", ")}）`);
        continue;
      }
      keep.push(name);
    }
    p.skills = keep;
    if (p.mcp.length) {
      // v2.0 は MCP を入れない（6.5）。書かれていても使わない
      warnings.push(`${id}: MCP はまだ使えないので外しました（${p.mcp.join(", ")}）`);
      p.mcp = [];
    }
  }
  for (const w of warnings) log?.warn(w);
  return { file, warnings };
}

/** 役割と職種から使うプロファイルの ID（agents.profile が無ければ役割の既定） */
export function profileIdFor(role: ClaudeRole, profile: string | null | undefined): string {
  if (role === "coo") return "coo";
  if (role === "leader") return "leader";
  return profile && (PROFILE_IDS as readonly string[]).includes(profile) ? profile : "generalist";
}

export function getProfile(profiles: ResolvedProfiles, id: string): Profile {
  return profiles.file.profiles[id] ?? profiles.file.profiles.generalist ?? { role: "member", model: "sonnet", skills: [], mcp: [] };
}

/** 画面向け（GET /api/profiles・ハートビート） */
export function profileViews(profiles: ResolvedProfiles): ProfileView[] {
  return Object.entries(profiles.file.profiles)
    .slice(0, 20)
    .map(([id, p]) => ({
      id,
      role: p.role,
      model: p.model,
      skills: p.skills,
      tools: [...ROLE_TOOLS[p.role], ...(p.skills.length ? ["Skill"] : [])],
      mcp: p.mcp,
      codexReview: p.codexReview === true,
    }));
}

// ───────────── --plugin-dir（6.1） ─────────────

const buildLocks = new Map<string, Promise<unknown>>();

/**
 * プロファイルのスキルを写した plugin フォルダを作り直す。スキルが無ければ null（--plugin-dir を付けない）。
 * 同じプロファイルの組み立ては直列にし、一時フォルダに作ってから入れ替える（動いている別セッションが半端な中身を見ないように）。
 */
export async function buildPluginDir(config: Pick<RunnerConfig, "dataDir" | "home">, profileId: string, profile: Profile): Promise<string | null> {
  if (profile.skills.length === 0) return null;
  const dir = dataPaths(config).profilePlugin(profileId);
  const prev = buildLocks.get(dir) ?? Promise.resolve();
  const job = prev.catch(() => undefined).then(async () => {
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(path.join(tmp, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(tmp, ".claude-plugin/plugin.json"), JSON.stringify({ name: `baton-${profileId}`, version: "1.0.0" }));
    for (const name of profile.skills) {
      const src = await realpath(path.join(skillsDir(config), name));
      await cp(src, path.join(tmp, "skills", name), { recursive: true, dereference: true, verbatimSymlinks: false });
    }
    const old = `${dir}.old-${process.pid}-${Date.now()}`;
    await rename(dir, old).catch(() => undefined);
    await mkdir(path.dirname(dir), { recursive: true });
    await rename(tmp, dir);
    await rm(old, { recursive: true, force: true });
    return dir;
  });
  buildLocks.set(dir, job);
  try {
    return await job;
  } finally {
    if (buildLocks.get(dir) === job) buildLocks.delete(dir);
  }
}

/** plugin フォルダの中のスキル名（テスト・記録用） */
export async function listPluginSkills(dir: string): Promise<string[]> {
  return (await readdir(path.join(dir, "skills")).catch(() => [] as string[])).sort();
}

// ───────────── CLAUDE.md の取り込み（6.3・D-86） ─────────────

/** 「## 見出し」単位で本文を取り出す（見出しの行は含めない。### 以下は本文に含める） */
export function extractSections(markdown: string, include: readonly string[]): string {
  const want = new Set(include.map((s) => s.trim()));
  const out: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null && want.has(current)) out.push(buf.join("\n").trim());
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && !line.startsWith("###")) {
      flush();
      current = (h[1] ?? "").trim();
      buf = [];
      continue;
    }
    if (/^#\s/.test(line)) {
      flush();
      current = null;
      buf = [];
      continue;
    }
    if (current !== null) buf.push(line);
  }
  flush();
  return out.filter(Boolean).join("\n\n");
}

export async function ceoStyleText(config: Pick<RunnerConfig, "home">, profiles: ResolvedProfiles): Promise<string> {
  const { source, includeSections, extra } = profiles.file.ceoStyle;
  const md = await readFile(expandHome(source, config.home), "utf8").catch(() => "");
  const body = extractSections(md, includeSections);
  return [body, extra].filter((s) => s.trim()).join("\n\n");
}

/** 既存リポジトリの決まり（CLAUDE.md・AGENTS.md の先頭 20,000 文字） */
export async function repoRulesText(repoDir: string | null): Promise<string> {
  if (!repoDir) return "";
  const parts: string[] = [];
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const p = path.join(repoDir, name);
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    const text = await readFile(p, "utf8").catch(() => "");
    if (text.trim()) parts.push(`### ${name}\n${text}`);
  }
  return parts.join("\n\n").slice(0, 20_000);
}

/** --append-system-prompt の全文（6.3 の順番） */
export async function buildSystemPrompt(input: {
  config: Pick<RunnerConfig, "home">;
  profiles: ResolvedProfiles;
  role: ClaudeRole;
  profileId: string;
  goal?: string | null;
  repoDir?: string | null;
  extra?: string | null;
}): Promise<string> {
  const parts: string[] = [`ROLE: ${input.role}`];
  const style = await ceoStyleText(input.config, input.profiles);
  if (style) parts.push(`## CEO の好み\n${style}`);
  parts.push(roleInstructions(input.role));
  const note = PROFILE_NOTES[input.profileId];
  if (input.role === "member" && note) parts.push(note);
  if (input.goal) parts.push(`## プロジェクトの目的\n${input.goal}`);
  const rules = await repoRulesText(input.repoDir ?? null);
  if (rules) parts.push(`## プロジェクトの決まり\n${rules}`);
  if (input.extra) parts.push(input.extra);
  parts.push(BATON_NOTE);
  return parts.join("\n\n");
}
