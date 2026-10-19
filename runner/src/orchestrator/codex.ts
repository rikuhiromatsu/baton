// Codex レビュー（DESIGN-v2 6.4、D-87）。統合後に 1 回だけ、ランナーが自動で回す（Claude のターンを使わない）。
// 条件: 既存リポジトリのプロジェクト、統合用の差分にコード（設定した拡張子）がある、チームに codexReview の職種がいる、BATON_CODEX_REVIEW≠off。
// codex は本人の OpenAI の枠を使う。時間切れ 15 分。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DiffStatEntry, ProjectWithTeam, Workspace } from "@baton/shared";
import { getProfile } from "../claude/profiles.ts";
import type { RunnerContext } from "../context.ts";
import { clip } from "./common.ts";

export async function shouldRunCodex(ctx: RunnerContext, input: { project: ProjectWithTeam; diff: DiffStatEntry[] }): Promise<boolean> {
  if (!ctx.config.codexReview) return false;
  if (input.project.workspaceKind !== "repo") return false;
  const exts = new Set(ctx.config.codexExtensions.map((e) => e.toLowerCase()));
  if (!input.diff.some((d) => d.change !== "D" && exts.has(path.extname(d.path).toLowerCase()))) return false;
  const profiles = await ctx.profiles();
  const team = input.project.agents.filter((a) => a.active && a.role === "member");
  if (!team.some((a) => getProfile(profiles, a.profile ?? "generalist").codexReview === true)) return false;
  return existsSync(ctx.config.codexScript);
}

/** 指摘の本文（回さなければ null） */
export async function runCodexReview(ctx: RunnerContext, input: { project: ProjectWithTeam; integration: Workspace; diff: DiffStatEntry[] }): Promise<string | null> {
  if (!(await shouldRunCodex(ctx, input))) return null;
  // ランナーのトークン・Anthropic の鍵は渡さない
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(BATON_RUNNER_TOKEN|ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k)) env[k] = v;
  ctx.log.info("Codex レビューを回します", { instructionId: input.integration.instructionId, dir: input.integration.worktreePath });
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "bash",
      [ctx.config.codexScript, "review", "--base", input.integration.baseSha],
      { cwd: input.integration.worktreePath, env, timeout: ctx.config.limits.codexTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
  const text = (out.stdout.trim() || out.stderr.trim()).slice(-12_000);
  if (!text) return out.code === 0 ? "Codex の指摘はありませんでした" : null;
  return clip(out.code === 0 ? text : `Codex レビューが失敗しました: ${text}`, 8000);
}
