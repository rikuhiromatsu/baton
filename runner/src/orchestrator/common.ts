// 役割の起動で共通の部品（モデル・プロファイル・システムプロンプト）。
import type { ProjectWithTeam } from "@baton/shared";
import { getProfile, buildSystemPrompt, profileIdFor, type Profile } from "../claude/profiles.ts";
import type { ClaudeRole } from "../claude/permissions.ts";
import type { RunnerContext } from "../context.ts";

/** モデル（5.9・D-61）: BATON_MODEL_* ＞ プロファイル。COO は sonnet に退避 */
export function modelFor(ctx: RunnerContext, role: ClaudeRole, profile: Profile): { model: string; fallback: string | null } {
  const model = ctx.config.modelOverride[role] ?? profile.model;
  return { model, fallback: role === "coo" && model !== "sonnet" ? "sonnet" : null };
}

export async function roleSetup(
  ctx: RunnerContext,
  input: { role: ClaudeRole; agentProfile?: string | null; project?: ProjectWithTeam | null; repoDir?: string | null; extra?: string | null },
): Promise<{ profileId: string; profile: Profile; model: string; fallback: string | null; systemPrompt: string }> {
  const profiles = await ctx.profiles();
  const profileId = profileIdFor(input.role, input.agentProfile);
  const profile = getProfile(profiles, profileId);
  const { model, fallback } = modelFor(ctx, input.role, profile);
  const systemPrompt = await buildSystemPrompt({
    config: ctx.config,
    profiles,
    role: input.role,
    profileId,
    goal: input.project?.goal ?? null,
    repoDir: input.repoDir ?? null,
    extra: input.extra ?? null,
  });
  return { profileId, profile, model, fallback, systemPrompt };
}

/** 既定のリーダーのスレッド ID（0002 の移し替えと同じ 'thread-' || project.id） */
export function leaderThreadIdOf(projectId: string): string {
  return `thread-${projectId}`;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 「HH:MM」（Asia/Tokyo） */
export function hhmm(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
