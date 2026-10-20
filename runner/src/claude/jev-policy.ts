// メンバーのモデルとエフォートを TypeSafe の Jev で決める方針（DESIGN-v2 5.9.1・D-128〜D-137）。I/O なし。
//
// 出どころ: 本人の Claude Code の mod「jev-model-router」の hooks/policy.ts
//   （claude-code-templates の mods/productivity/jev-model-router/hooks/policy.ts。MIT License）
// 写した日: 2026-10-20
//
// 変えた所:
//   - typesafe の形だけを残した（Gateway・内蔵の分類・selectProvider・endpoint・requestHeaders は写さない。鍵が無ければ振り分けない）
//   - ALIAS_IDS・requestModelId() は写さない（--model は別名 haiku / sonnet / opus をそのまま受ける）
//   - pendingDecisions・describeSetup・describeStatus は使わないので写さない
//   - questions() と requestBody() から provider の引数を外した（risky は常に noul）
//   - 足したもの: ASSUMED_DEFAULT_EFFORT・clampRouting()（route() のあとに Baton の上限を当てる。D-131）・
//     redactSecrets()・buildJevState()（Jev に渡す state。D-137）・routingSummary()
//   - route()・readDecision()・effortLevel()・effortRank()・rankOf()・allowed()・describeDecision() は mod のまま
//
// ───────────── 以下、mod から写した部分 ─────────────

export type Tier = "fast" | "balanced" | "deep";

export interface Tiers {
  fast: string;
  balanced: string;
  deep: string;
}

export interface Decision {
  tier: Tier;
  /** Confidence in the tier, or null when the backend reported none. */
  confidence: number | null;
  /** P(true) that carrying the task out would itself be costly or final. */
  risky: number | null;
  /** 0..3 along the effort rubric, or null when absent. */
  effort: number | null;
  /** Confidence in the effort, or null when the backend reported none. */
  effortConfidence: number | null;
}

/** The reasoning levels a turn can ask for, cheapest first. */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;

export type Effort = (typeof EFFORT_ORDER)[number];

export const TIER_ORDER: readonly Tier[] = ["fast", "balanced", "deep"];

/**
 * How each tier is described to the decision model. Deliberately about the
 * shape of the work, not about model names: the model never sees an id.
 */
const TIER_CRITERIA: Record<Tier, string> = {
  fast: "Mechanical and local: read or summarise a file, run one command, rename a symbol, answer something already in context.",
  balanced:
    "Ordinary engineering: implement a well-specified change across a few files, write tests, fix a clearly described bug, review a small diff.",
  deep: "Hard or high-stakes: architecture and design, debugging a failure whose cause is unknown, security, data migrations, concurrency, anything touching production or money.",
};

const EFFORT_RUBRIC = ["almost none", "some", "a lot", "as much as possible"] as const;

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

/** The `questions` map (typesafe の形。risky は noul). */
export function questions(): Record<string, unknown> {
  return {
    tier: {
      type: "choice",
      instructions: "Which is the cheapest tier that can complete this coding task well?",
      criteria: TIER_CRITERIA,
    },
    effort: {
      type: "score",
      instructions: "How much step-by-step reasoning does this task need?",
      criteria: EFFORT_RUBRIC,
    },
    risky: {
      type: "noul",
      // Asked about the act, not the subject. The first wording ("the task
      // touches production, money, credentials") scored 0.96 on "add a
      // refund endpoint that calls Stripe" — ordinary code that happens to be
      // about money — and would have escalated it past a 0.98-confidence
      // answer of the balanced tier.
      instructions:
        "Carrying out this task would itself change production, move real money, or alter data that cannot be restored. Writing or testing code that deals with such things, without running it against the real system, does not count.",
    },
  };
}

/** The request body. */
export function requestBody(state: Record<string, unknown>, model: string): string {
  return JSON.stringify({ model, state, questions: questions() });
}

function isTier(value: unknown): value is Tier {
  return value === "fast" || value === "balanced" || value === "deep";
}

/**
 * Reads a response. TypeSafe's own API reports a `confidence` per answer and
 * a `noul` number for a yes/no question. A missing confidence reads as null
 * rather than as a number the policy would trust.
 */
export function readDecision(responseText: string): Decision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> }).answers;
  if (!answers) return null;

  const tierAnswer = answers.tier;
  if (!tierAnswer || !isTier(tierAnswer.choice)) return null;

  const effortAnswer = answers.effort;
  const riskyAnswer = answers.risky;
  const risky =
    typeof riskyAnswer?.noul === "number"
      ? riskyAnswer.noul
      : typeof riskyAnswer?.probability === "number"
        ? riskyAnswer.probability
        : null;

  return {
    tier: tierAnswer.choice,
    confidence: confidenceOf(tierAnswer),
    effort: typeof effortAnswer?.score === "number" ? effortAnswer.score : null,
    effortConfidence: effortAnswer ? confidenceOf(effortAnswer) : null,
    risky,
  };
}

function confidenceOf(answer: Record<string, unknown>): number | null {
  if (typeof answer.confidence === "number") return answer.confidence;
  const probabilities = answer.probabilities as Record<string, number> | undefined;
  const values = probabilities ? Object.values(probabilities) : [];
  return values.length > 0 ? Math.max(...values) : null;
}

/** The rubric score (0..3) as a reasoning level. */
export function effortLevel(score: number): Effort {
  const index = Math.min(EFFORT_ORDER.length - 1, Math.max(0, Math.round(score)));
  return EFFORT_ORDER[index] as Effort;
}

/**
 * Where a reasoning level sits on the ladder, or null when its place cannot
 * be known. `max` is above every rung the rubric can produce, so it ranks
 * above them without joining EFFORT_ORDER.
 */
export function effortRank(effort: string | number | undefined): number | null {
  if (typeof effort !== "string") return null;
  if (effort === "max") return EFFORT_ORDER.length;
  const index = EFFORT_ORDER.indexOf(effort as Effort);
  return index === -1 ? null : index;
}

/**
 * Where a model id sits on the tier ladder, by matching it against the
 * configured tier names first and then the family words. Null when it matches
 * none, in which case the change is treated as an upgrade rather than guessed
 * at: an unrecognised id gets the gentler threshold, never the strict one.
 */
export function rankOf(model: string, tiers: Tiers): number | null {
  const lowered = model.toLowerCase();
  for (let index = 0; index < TIER_ORDER.length; index++) {
    const tier = TIER_ORDER[index] as Tier;
    const configured = tiers[tier].toLowerCase();
    if (configured && lowered.includes(configured)) return index;
  }
  if (lowered.includes("haiku")) return 0;
  if (lowered.includes("sonnet")) return 1;
  if (lowered.includes("opus")) return 2;
  return null;
}

export interface PolicyConfig {
  tiers: Tiers;
  /**
   * How sure the decision must be to spend more (a bigger model, more
   * reasoning). Being wrong here costs money, so the bar is low.
   */
  minUpgradeConfidence: number;
  /**
   * How sure it must be to spend less. Being wrong here means a task handled
   * by too small a model or too little thought, so the bar is high.
   */
  minDowngradeConfidence: number;
}

export interface Routing {
  /** The model to run on, or null to leave the request as it is. */
  model: string | null;
  /** The reasoning level to ask for, or null to leave it as it is. */
  effort: Effort | null;
  /** Why, for the log line. */
  reason: string;
}

const NOTHING: Routing = { model: null, effort: null, reason: "no decision" };

/**
 * Whether a change of rank passes its threshold. Both directions are allowed;
 * they just do not have to clear the same bar, because the two mistakes do not
 * cost the same. A move whose direction cannot be told (an unrecognised
 * current value) is treated as an upgrade.
 */
function allowed(wanted: number, current: number | null, confidence: number | null, config: PolicyConfig): boolean {
  if (current !== null && wanted === current) return false;
  const isDowngrade = current !== null && wanted < current;
  const bar = isDowngrade ? config.minDowngradeConfidence : config.minUpgradeConfidence;
  // A backend that reports no confidence clears the upgrade bar but never the
  // downgrade one: spending less on an unmeasured hunch is the bad trade.
  if (confidence === null) return !isDowngrade;
  return confidence >= bar;
}

/**
 * Turns a decision into a model and a reasoning level, either of which may be
 * null to leave the request as it is. Both can move in either direction.
 */
export function route(decision: Decision | null, current: { model: string; effort?: string | number }, config: PolicyConfig): Routing {
  if (!decision) return NOTHING;

  let tier = decision.tier;
  let effortScore = decision.effort;
  let forced = false;

  // Carrying out something final is never worth the saving: take the deep
  // tier and real reasoning, whatever the cheaper answer said, and skip the
  // thresholds — this is the one case that is not a confidence question.
  if (decision.risky !== null && decision.risky > 0.7) {
    tier = "deep";
    effortScore = Math.max(effortScore ?? 0, 2);
    forced = true;
  }

  const wantedTier = TIER_ORDER.indexOf(tier);
  const currentTier = rankOf(current.model, config.tiers);
  const wantedModel = config.tiers[tier];

  const model =
    wantedModel && wantedModel !== current.model && (forced || allowed(wantedTier, currentTier, decision.confidence, config))
      ? wantedModel
      : null;

  let effort: Effort | null = null;
  if (effortScore !== null) {
    const currentRank = effortRank(current.effort);
    let wantedRank = EFFORT_ORDER.indexOf(effortLevel(effortScore));

    // Risk raises the floor; it must never lower one.
    if (forced && currentRank !== null) wantedRank = Math.max(wantedRank, currentRank);

    // A numeric effort is the caller's own scale, not this ladder; leave it.
    const comparable = typeof current.effort !== "number";
    const wanted = EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, wantedRank)] as Effort;
    if (comparable && wantedRank !== currentRank && (forced || allowed(wantedRank, currentRank, decision.effortConfidence, config))) {
      effort = wanted;
    }
  }

  const said = decision.confidence === null ? "confidence n/d" : `confidence ${decision.confidence.toFixed(2)}`;

  if (!model && !effort) {
    // Naming what it wanted and what it kept is the whole point of this line.
    const wantedEffort = effortScore === null ? null : effortLevel(effortScore);
    const kept = `${current.model}${current.effort === undefined ? "" : `/${current.effort}`}`;
    const wanted = `${wantedModel}${wantedEffort ? `/${wantedEffort}` : ""}`;
    return { model: null, effort: null, reason: `kept ${kept}, wanted ${wanted} (${said})` };
  }

  return { model, effort, reason: forced ? `${tier}, forced by risk` : `${tier} (${said})` };
}

/** A number for the log, or `n/d` when the backend reported none. */
function reported(value: number | null): string {
  return value === null ? "n/d" : value.toFixed(2);
}

/** What the decision model answered, before any policy touches it (1 行). */
export function describeDecision(decision: Decision | null, ms: number | null): string {
  const took = ms === null ? "" : ` · ${Math.round(ms)}ms`;
  if (!decision) return `no answer${took}`;

  const parts = [`tier ${decision.tier} (${reported(decision.confidence)})`];
  if (decision.effort !== null) {
    parts.push(`effort ${decision.effort.toFixed(1)} → ${effortLevel(decision.effort)} (${reported(decision.effortConfidence)})`);
  }
  if (decision.risky !== null) parts.push(`risky ${reported(decision.risky)}`);
  return parts.join(" · ") + took;
}

// ───────────── 以下、Baton で足した部分 ─────────────

export const MODEL_ORDER = ["haiku", "sonnet", "opus"] as const;
export type ModelName = (typeof MODEL_ORDER)[number];

/** 段とモデルの対応（5.9.1） */
export const DEFAULT_TIERS: Tiers = { fast: "haiku", balanced: "sonnet", deep: "opus" };

/**
 * 基準のエフォートが無い職種（--effort を付けない）を route() で比べるときに「これ」とみなす値。
 * Claude Code の既定のエフォートは init に出ず確かめられないので、1 か所の定数にしておく（D-130）。
 */
export const ASSUMED_DEFAULT_EFFORT: Effort = "medium";

/** 枠が近いときに上げない境目（BATON_JEV_UPGRADE_QUOTA。9.2） */
export type UpgradeQuota = { fiveHour: number; sevenDay: number };
export const DEFAULT_UPGRADE_QUOTA: UpgradeQuota = { fiveHour: 0.6, sevenDay: 0.75 };

export const DEFAULT_MIN_UPGRADE = 0.3;
export const DEFAULT_MIN_DOWNGRADE = 0.6;

function modelRank(model: string): number | null {
  return rankOf(model, DEFAULT_TIERS);
}

export type ClampInput = {
  /** route() の答え */
  routing: Routing;
  /** 基準（プロファイルのモデルと、プロファイルの effort。無ければ null） */
  base: { model: string; effort: Effort | null };
  /** プロファイルの jev: { min, max } */
  limits: { min: ModelName; max: ModelName };
  /** 衝突の解決のタスク（下限 sonnet） */
  conflictResolution: boolean;
  /** 枠の使用率（未観測は null） */
  quota: { fiveHour: number | null; sevenDay: number | null };
  quotaThresholds?: UpgradeQuota;
};

export type ClampResult = {
  model: string;
  /** --effort に渡す値。基準と同じなら基準のまま（基準が無ければ null = 付けない） */
  effort: Effort | null;
  /** 上限で動かした内容（記録用） */
  clamped: string[];
};

/**
 * route() の答えに Baton の上限を当てる（5.9.1・D-131）。risky の強制もこの範囲を越えない。
 * 順番: モデルの下限・上限 → エフォートの上限（xhigh は opus のとき、max は無い）→ 枠が近いときは基準より上げない。
 */
export function clampRouting(input: ClampInput): ClampResult {
  const clamped: string[] = [];
  const { routing, base, limits } = input;
  const thresholds = input.quotaThresholds ?? DEFAULT_UPGRADE_QUOTA;

  // ── モデル
  const baseRank = modelRank(base.model);
  let model = routing.model ?? base.model;
  const minName: ModelName = input.conflictResolution && MODEL_ORDER.indexOf(limits.min) < MODEL_ORDER.indexOf("sonnet") ? "sonnet" : limits.min;
  if (input.conflictResolution && minName !== limits.min) clamped.push("衝突の解決は sonnet 以上");
  const minRank = MODEL_ORDER.indexOf(minName);
  const maxRank = Math.max(minRank, MODEL_ORDER.indexOf(limits.max));
  const rank = modelRank(model);
  if (rank !== null && rank < minRank) {
    clamped.push(`モデルを ${MODEL_ORDER[minRank]} に引き上げ（下限。${model} → ${MODEL_ORDER[minRank]}）`);
    model = MODEL_ORDER[minRank] as string;
  } else if (rank !== null && rank > maxRank) {
    clamped.push(`モデルを ${MODEL_ORDER[maxRank]} に制限（上限。${model} → ${MODEL_ORDER[maxRank]}）`);
    model = MODEL_ORDER[maxRank] as string;
  }

  // ── 枠が近いとき（モデルは基準より上げない）
  const overQuota = (input.quota.fiveHour ?? 0) >= thresholds.fiveHour || (input.quota.sevenDay ?? 0) >= thresholds.sevenDay;
  if (overQuota) {
    const r = modelRank(model);
    if (baseRank !== null && r !== null && r > baseRank) {
      clamped.push(`枠が近いのでモデルを上げない（${model} → ${base.model}）`);
      model = base.model;
    }
  }

  // ── エフォート
  const baseEffortForCompare: Effort = base.effort ?? ASSUMED_DEFAULT_EFFORT;
  let effort: Effort = routing.effort ?? baseEffortForCompare;
  const finalIsOpus = modelRank(model) === 2;
  if (effort === "xhigh" && !finalIsOpus) {
    clamped.push("xhigh は opus のときだけ（high に制限）");
    effort = "high";
  }
  if (overQuota && EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(baseEffortForCompare)) {
    clamped.push(`枠が近いのでエフォートを上げない（${effort} → ${baseEffortForCompare}）`);
    effort = baseEffortForCompare;
  }
  // 基準と同じなら基準のまま（基準が無ければ --effort を付けない。今の起動とまったく同じ引数になる）
  const sameAsBase = effort === baseEffortForCompare;
  return { model, effort: sameAsBase ? base.effort : effort, clamped };
}

// ───────────── Jev に渡す state（D-137） ─────────────

/** 鍵らしい文字列の置き換え先 */
export const REDACTED = "[伏せ字]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bbtn_bot_[A-Za-z0-9_-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /[A-Za-z0-9+/=_-]{40,}/g,
];

/** 鍵らしい文字列を [伏せ字] にする（spec・title・paths に通す） */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export const PROFILE_ONE_LINERS: Record<string, string> = {
  engineer: "コードを書き、テストを回す",
  researcher: "調べて、根拠をつけてまとめる",
  writer: "文章を書き、読みやすく整える",
  generalist: "頼まれた作業を幅広くこなす",
};

export const SPEC_MAX_CHARS = 4000;
export const TITLE_MAX_CHARS = 80;
export const PATHS_MAX = 20;

export type JevMemberState = {
  kind: "baton_member_task";
  title: string;
  spec: string;
  paths: string[];
  profile: string;
  profileNote: string;
  workspace: "repo" | "baton";
  round: 1 | 2;
  conflictResolution: boolean;
  dependsOn: number;
  limits: { maxTurns: number };
};

export type JevStateInput = {
  title: string;
  spec: string;
  paths: readonly string[];
  profileId: string;
  workspaceKind: "repo" | "baton";
  round: number;
  conflictResolution: boolean;
  /** 依存タスクの数（結果の本文は渡さない） */
  dependsOn: number;
  maxTurns: number;
};

function clipText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Jev に渡す state。目的（goal）・リポジトリのパス・依存の結果の本文・ファイルの中身・会話は入れない */
export function buildJevState(input: JevStateInput): JevMemberState {
  return {
    kind: "baton_member_task",
    title: clipText(redactSecrets(input.title), TITLE_MAX_CHARS),
    spec: clipText(redactSecrets(input.spec), SPEC_MAX_CHARS),
    paths: input.paths.slice(0, PATHS_MAX).map((p) => clipText(redactSecrets(p), 200)),
    profile: input.profileId,
    profileNote: PROFILE_ONE_LINERS[input.profileId] ?? PROFILE_ONE_LINERS.generalist!,
    workspace: input.workspaceKind,
    round: input.round >= 2 ? 2 : 1,
    conflictResolution: input.conflictResolution,
    dependsOn: input.dependsOn,
    limits: { maxTurns: input.maxTurns },
  };
}

/** トランスクリプトの「モデル」の 1 行の本文（detail。先頭の「モデル 」はラベルが付ける） */
export function launchDetail(input: {
  model: string;
  effort: string | null;
  source: "jev" | "shadow" | "profile" | "fixed" | "resume";
  decision: Decision | null;
  jevFailed: boolean;
  changed: boolean;
  wouldChoose?: string;
}): string {
  const head = `${input.model}${input.effort ? `・エフォート ${input.effort}` : ""}`;
  switch (input.source) {
    case "resume":
      return `${head}（前回と同じ）`;
    case "fixed":
      return `${head}（固定）`;
    case "shadow":
      return `${head}（Jev 試し運転${input.wouldChoose ? `: ${input.wouldChoose} を選ぶはず` : input.jevFailed ? ": 聞けず" : ": 判定どおり"}）`;
    case "jev":
      if (!input.decision || input.jevFailed) return `${head}（Jev に聞けず）`;
      return input.changed ? `${head}（Jev: ${input.decision.tier} ${reported(input.decision.confidence)}）` : `${head}（Jev: 判定どおり）`;
    default:
      return input.jevFailed ? `${head}（Jev に聞けず）` : `${head}（プロファイルのまま）`;
  }
}
