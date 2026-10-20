// 役割の起動で共通の部品（モデル・プロファイル・システムプロンプト）。
import { runnerEventItem, type ProjectWithTeam, type Task, type TranscriptDraft } from "@baton/shared";
import { getProfile, buildSystemPrompt, profileIdFor, type Profile } from "../claude/profiles.ts";
import type { ClaudeRole } from "../claude/permissions.ts";
import {
  DEFAULT_TIERS,
  ASSUMED_DEFAULT_EFFORT,
  buildJevState,
  clampRouting,
  describeDecision,
  launchDetail,
  route,
  type Decision,
  type Effort,
} from "../claude/jev-policy.ts";
import type { RunnerContext } from "../context.ts";
import type { LaunchRecord } from "../state.ts";

/** モデル（5.9・D-61・D-127）: BATON_MODEL_* ＞ プロファイル。COO・リーダーは sonnet 以外なら sonnet に退避 */
export function modelFor(ctx: RunnerContext, role: ClaudeRole, profile: Profile): { model: string; fallback: string | null } {
  const model = ctx.config.modelOverride[role] ?? profile.model;
  return { model, fallback: role !== "member" && model !== "sonnet" ? "sonnet" : null };
}

export type MemberLaunch = {
  model: string;
  /** --effort の値。null は付けない */
  effort: string | null;
  source: LaunchRecord["source"];
  reason: string;
  /** トランスクリプトの「モデル」の 1 行（Jev を使わない設定のときは null） */
  item: TranscriptDraft | null;
  /** 手元の状態に残す値（--resume と引き継ぎで使う） */
  record: LaunchRecord;
};

const JEV_GRACE_MS = 250;

/** 時間切れの競争。Jev のクライアントが遅れても、起動を待たせるのは timeoutMs + 少しだけ（D-132） */
async function askJev(ctx: RunnerContext, state: Record<string, unknown>): Promise<{ decision: Decision | null; ms: number; error: string | null }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ctx.config.jev.timeoutMs + JEV_GRACE_MS);
      timer.unref?.();
    });
    const r = await Promise.race([ctx.jev.decide(state), limit]);
    if (r === "timeout") return { decision: null, ms: Date.now() - started, error: "timeout" };
    return r.decision ? r : { decision: null, ms: r.ms, error: r.error ?? "bad_body" };
  } catch {
    return { decision: null, ms: Date.now() - started, error: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * メンバーの新しいセッションのモデルとエフォートを決める（5.9.1）。
 * previous（手元の launch）があれば Jev を呼ばずそれを返す（--resume・引き継ぎ。D-133）。
 */
export async function memberLaunchFor(
  ctx: RunnerContext,
  input: {
    profileId: string;
    profile: Profile;
    task: Task | null;
    round: number;
    conflict: boolean;
    workspaceKind: "repo" | "baton";
    previous?: LaunchRecord | null;
  },
): Promise<MemberLaunch> {
  const { profile } = input;
  const { config } = ctx;
  const mode = config.jev.routing;
  const baseEffort = profile.effort ?? null;
  const now = ctx.now();
  const make = (v: { model: string; effort: string | null; source: LaunchRecord["source"]; reason: string; decision?: Decision | null; ms?: number; clamped?: string[]; detail: string }): MemberLaunch => {
    const record: LaunchRecord = input.previous ?? { model: v.model, effort: v.effort, source: v.source, at: now };
    const item =
      mode === "off"
        ? null
        : runnerEventItem(
            "モデル",
            {
              model: v.model,
              effort: v.effort,
              baseModel: profile.model,
              baseEffort,
              source: v.source,
              reason: v.reason,
              decision: v.decision ? { tier: v.decision.tier, confidence: v.decision.confidence, effort: v.decision.effort, effortConfidence: v.decision.effortConfidence, risky: v.decision.risky, ms: v.ms ?? 0 } : null,
              clamped: v.clamped ?? [],
            },
            v.detail,
          );
    return { model: v.model, effort: v.effort, source: v.source, reason: v.reason, item, record };
  };

  if (input.previous) {
    const p = input.previous;
    return make({ model: p.model, effort: p.effort, source: "resume", reason: "前回と同じ", detail: launchDetail({ model: p.model, effort: p.effort, source: "resume", decision: null, jevFailed: false, changed: false }) });
  }
  const fixed = config.modelOverride.member;
  if (fixed) {
    return make({ model: fixed, effort: baseEffort, source: "fixed", reason: "BATON_MODEL_MEMBER", detail: launchDetail({ model: fixed, effort: baseEffort, source: "fixed", decision: null, jevFailed: false, changed: false }) });
  }
  if (mode === "off" || !profile.jev || !input.task) {
    return make({ model: profile.model, effort: baseEffort, source: "profile", reason: mode === "off" ? "BATON_JEV_ROUTING=off" : "振り分けの対象外", detail: launchDetail({ model: profile.model, effort: baseEffort, source: "profile", decision: null, jevFailed: false, changed: false }) });
  }

  // ── Jev に聞く
  const state = buildJevState({
    title: input.task?.title ?? "",
    spec: input.task?.spec ?? "",
    paths: input.task?.paths ?? [],
    profileId: input.profileId,
    workspaceKind: input.workspaceKind,
    round: input.round,
    conflictResolution: input.conflict,
    dependsOn: input.task?.dependsOn.length ?? 0,
    maxTurns: config.limits.maxTurns.member,
  });
  const asked = await askJev(ctx, state as unknown as Record<string, unknown>);
  if (!asked.decision) {
    ctx.log.warn("Jev に聞けませんでした", { reason: asked.error ?? "bad_body", ms: asked.ms });
    return make({
      model: profile.model,
      effort: baseEffort,
      source: "profile",
      reason: `Jev に聞けず（${asked.error ?? "bad_body"}）`,
      ms: asked.ms,
      detail: launchDetail({ model: profile.model, effort: baseEffort, source: "profile", decision: null, jevFailed: true, changed: false }),
    });
  }
  const decision = asked.decision;
  ctx.log.info("Jev の判定", { summary: describeDecision(decision, asked.ms) });

  const routing = route(
    decision,
    { model: profile.model, effort: baseEffort ?? ASSUMED_DEFAULT_EFFORT },
    { tiers: DEFAULT_TIERS, minUpgradeConfidence: config.jev.minUpgradeConfidence, minDowngradeConfidence: config.jev.minDowngradeConfidence },
  );
  const quota = ctx.quota.current;
  const clamp = clampRouting({
    routing,
    base: { model: profile.model, effort: baseEffort as Effort | null },
    limits: profile.jev,
    conflictResolution: input.conflict,
    quota: { fiveHour: quota.fiveHour.utilization, sevenDay: quota.sevenDay.utilization },
    quotaThresholds: config.jev.upgradeQuota,
  });
  const picked = `${clamp.model}${clamp.effort ? `/${clamp.effort}` : ""}`;
  ctx.log.info("メンバーのモデル", { picked, reason: routing.reason, clamped: clamp.clamped, mode });
  const changed = clamp.model !== profile.model || clamp.effort !== baseEffort;
  if (mode === "shadow") {
    // 試し運転: 呼んで記録するが、起動はプロファイルのまま
    return make({
      model: profile.model,
      effort: baseEffort,
      source: "shadow",
      reason: `${routing.reason}（選んだはず: ${picked}）`,
      decision,
      ms: asked.ms,
      clamped: clamp.clamped,
      detail: launchDetail({ model: profile.model, effort: baseEffort, source: "shadow", decision, jevFailed: false, changed: false, wouldChoose: changed ? picked : undefined }),
    });
  }
  return make({
    model: clamp.model,
    effort: clamp.effort,
    source: "jev",
    reason: routing.reason,
    decision,
    ms: asked.ms,
    clamped: clamp.clamped,
    detail: launchDetail({ model: clamp.model, effort: clamp.effort, source: "jev", decision, jevFailed: false, changed }),
  });
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
