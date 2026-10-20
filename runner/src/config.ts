// 設定の読み込み。BATON_ENV_FILE の env ファイル → 環境変数の順に読み、環境変数が優先（v1 と同じ）。
// v2 で足したもの: claude の実行ファイル（BATON_CLAUDE_BIN）、役割ごとのモデル（BATON_MODEL_*）、
// スレッドのプロセスを生かす時間・承認の待ち時間、追加の許可ドメイン・Bash、Codex レビュー、プロファイルの置き場所。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LIMITS } from "@baton/shared";
import { DEFAULT_BASE_URL, DEFAULT_MIN_DOWNGRADE, DEFAULT_MIN_UPGRADE, DEFAULT_MODEL, DEFAULT_UPGRADE_QUOTA } from "./claude/jev-policy.ts";

export const RUNNER_VERSION = "0.2.0";

export const DEFAULT_ALLOWED_ORIGINS = ["https://baton.rikuhiromatsu.workers.dev", "http://localhost:8790"];

/** ランナーが使う上限（shared の LIMITS を元に BATON_LIMIT_<名前> で上書きできる） */
export type RunnerLimits = {
  threadProcesses: number;
  memberProcesses: number;
  memberParallel: number;
  threadIdleMs: number;
  maxTurns: { coo: number; leader: number; member: number };
  maxBudgetUsd: { coo: number; leader: number; member: number };
  instructionCostUsd: number;
  instructionWallClockMs: number;
  approvalsPerInstruction: number;
  maxRounds: number;
  approvalWaitMs: number;
  turnRetries: number;
  sessionTurnsBeforeRotate: number;
  conversationBreakMs: number;
  cancelCloseStdinMs: number;
  cancelSigtermMs: number;
  shutdownGraceMs: number;
  heartbeatIntervalMs: number;
  claimPollIntervalMs: number;
  transcriptFlushMs: number;
  streamFlushMs: number;
  authCheckIntervalMs: number;
  codexTimeoutMs: number;
  gitLockRetryDelaysMs: number[];
  staleIndexLockMs: number;
  quotaResumeMarginMs: number;
};

export function defaultLimits(): RunnerLimits {
  return {
    threadProcesses: LIMITS.threadProcesses,
    memberProcesses: LIMITS.memberProcesses,
    memberParallel: LIMITS.memberParallel,
    threadIdleMs: LIMITS.threadIdleMs,
    maxTurns: { ...LIMITS.maxTurns },
    maxBudgetUsd: { ...LIMITS.maxBudgetUsd },
    instructionCostUsd: LIMITS.instructionCostUsd,
    instructionWallClockMs: LIMITS.instructionWallClockMs,
    approvalsPerInstruction: LIMITS.approvalsPerInstruction,
    maxRounds: LIMITS.maxRounds,
    approvalWaitMs: LIMITS.approvalWaitMs,
    turnRetries: LIMITS.turnRetries,
    sessionTurnsBeforeRotate: LIMITS.sessionTurnsBeforeRotate,
    conversationBreakMs: LIMITS.conversationBreakMs,
    cancelCloseStdinMs: LIMITS.cancelCloseStdinMs,
    cancelSigtermMs: LIMITS.cancelSigtermMs,
    shutdownGraceMs: LIMITS.shutdownGraceMs,
    heartbeatIntervalMs: LIMITS.heartbeatIntervalMs,
    claimPollIntervalMs: LIMITS.claimPollIntervalMs,
    transcriptFlushMs: LIMITS.transcriptFlushMs,
    streamFlushMs: LIMITS.streamFlushMs,
    authCheckIntervalMs: 60 * 60 * 1000,
    codexTimeoutMs: 15 * 60 * 1000,
    gitLockRetryDelaysMs: [1000, 3000, 10_000],
    staleIndexLockMs: 10 * 60 * 1000,
    quotaResumeMarginMs: LIMITS.quotaResumeMarginMs,
  };
}

export type Role = "coo" | "leader" | "member";

export type RunnerConfig = {
  batonUrl: string;
  token: string;
  runnerName: string;
  dataDir: string;
  /** 本人のホーム（スキル・CLAUDE.md・~/projects の基準） */
  home: string;
  tailnetUrl: string | null;
  localPort: number;
  allowedTailnetLogins: string[];
  allowedOrigins: string[];
  /** false のとき local-server は Tailscale-User-Login を検査しない（e2e 専用） */
  localAuth: boolean;
  version: string;
  limits: RunnerLimits;
  apiRetryDelaysMs: number[];
  /** claude の実行ファイル（偽 claude に差し替える。15.1） */
  claudeBin: string;
  /** 役割ごとのモデルの上書き（BATON_MODEL_COO・BATON_MODEL_LEADER・BATON_MODEL_MEMBER） */
  modelOverride: Partial<Record<Role, string>>;
  /** リポジトリの既定のプロファイル（runner/profiles/profiles.json） */
  profilesPath: string;
  /** Mac mini の上書き（<DATA>/config/profiles.local.json） */
  profilesLocalPath: string;
  /** 通信の追加の許可ドメイン（BATON_EXTRA_ALLOWED_DOMAINS） */
  extraAllowedDomains: string[];
  /** メンバーの Bash の追加の許可ルール（BATON_EXTRA_BASH_ALLOW。「npm run lint,make test」→ Bash(…)） */
  extraBashAllow: string[];
  /** Codex レビュー（6.4）。BATON_CODEX_REVIEW=off で止める */
  codexReview: boolean;
  codexScript: string;
  /** Codex レビューの対象にする拡張子 */
  codexExtensions: string[];
  /** リポジトリの候補を探す場所（~/projects） */
  projectsScanRoot: string;
  /** 自分自身のリポジトリ（候補から外す） */
  selfRepo: string;
  /** トランスクリプトの tool_result を要約だけにする（BATON_TRANSCRIPT_LEVEL=summary） */
  transcriptSummaryOnly: boolean;
  /** メンバーのモデルとエフォートの振り分け（Jev。5.9.1） */
  jev: JevConfig;
};

export type JevRouting = "off" | "shadow" | "on";

export type JevConfig = {
  /** off（既定）: 呼ばない / shadow: 呼んで記録だけ / on: 結果で起動する（BATON_JEV_ROUTING） */
  routing: JevRouting;
  /** BATON_TYPESAFE_BASE_URL */
  baseUrl: string;
  /** BATON_TYPESAFE_MODEL */
  model: string;
  /** BATON_JEV_TIMEOUT_MS */
  timeoutMs: number;
  /** BATON_JEV_MIN_UPGRADE・BATON_JEV_MIN_DOWNGRADE */
  minUpgradeConfidence: number;
  minDowngradeConfidence: number;
  /** BATON_JEV_UPGRADE_QUOTA（「5 時間枠,週の枠」） */
  upgradeQuota: { fiveHour: number; sevenDay: number };
  /** BATON_TYPESAFE_API_KEY（ログ・D1・子には出さない。無ければ null） */
  apiKey: string | null;
};

function ratio(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} は 0〜1 の数値にしてください`);
  return n;
}

function jevConfig(env: Record<string, string | undefined>): JevConfig {
  const routing = (env.BATON_JEV_ROUTING || "off").trim();
  if (routing !== "off" && routing !== "shadow" && routing !== "on") throw new Error("BATON_JEV_ROUTING は off / shadow / on のどれかにしてください");
  const quota = list(env.BATON_JEV_UPGRADE_QUOTA);
  if (env.BATON_JEV_UPGRADE_QUOTA && quota.length !== 2) throw new Error("BATON_JEV_UPGRADE_QUOTA は「0.6,0.75」の形にしてください");
  return {
    routing,
    baseUrl: (env.BATON_TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.BATON_TYPESAFE_MODEL || DEFAULT_MODEL,
    timeoutMs: env.BATON_JEV_TIMEOUT_MS ? num("BATON_JEV_TIMEOUT_MS", env.BATON_JEV_TIMEOUT_MS) : 1500,
    minUpgradeConfidence: ratio("BATON_JEV_MIN_UPGRADE", env.BATON_JEV_MIN_UPGRADE, DEFAULT_MIN_UPGRADE),
    minDowngradeConfidence: ratio("BATON_JEV_MIN_DOWNGRADE", env.BATON_JEV_MIN_DOWNGRADE, DEFAULT_MIN_DOWNGRADE),
    upgradeQuota: {
      fiveHour: ratio("BATON_JEV_UPGRADE_QUOTA", quota[0], DEFAULT_UPGRADE_QUOTA.fiveHour),
      sevenDay: ratio("BATON_JEV_UPGRADE_QUOTA", quota[1], DEFAULT_UPGRADE_QUOTA.sevenDay),
    },
    apiKey: env.BATON_TYPESAFE_API_KEY?.trim() || null,
  };
}

/** KEY=VALUE の行を読む。# で始まる行と空行は無視。値の前後の引用符は外す */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toEnvName(key: string): string {
  return "BATON_LIMIT_" + key.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function num(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} は 0 以上の数値にしてください`);
  return n;
}

export function applyLimitOverrides(base: RunnerLimits, env: Record<string, string | undefined>): RunnerLimits {
  const out: RunnerLimits = {
    ...base,
    maxTurns: { ...base.maxTurns },
    maxBudgetUsd: { ...base.maxBudgetUsd },
    gitLockRetryDelaysMs: [...base.gitLockRetryDelaysMs],
  };
  for (const key of Object.keys(out) as (keyof RunnerLimits)[]) {
    const v = env[toEnvName(key)];
    if (v === undefined || v === "") continue;
    if (typeof out[key] === "number") (out[key] as number) = num(toEnvName(key), v);
  }
  for (const role of ["coo", "leader", "member"] as const) {
    const t = env[`BATON_MAX_TURNS_${role.toUpperCase()}`];
    if (t) out.maxTurns[role] = num(`BATON_MAX_TURNS_${role.toUpperCase()}`, t);
    const b = env[`BATON_MAX_BUDGET_${role.toUpperCase()}`];
    if (b) out.maxBudgetUsd[role] = num(`BATON_MAX_BUDGET_${role.toUpperCase()}`, b);
  }
  // 設計書・E2E で使う短い名前（15.3）
  if (env.BATON_THREAD_IDLE_MS) out.threadIdleMs = num("BATON_THREAD_IDLE_MS", env.BATON_THREAD_IDLE_MS);
  if (env.BATON_APPROVAL_WAIT_MS) out.approvalWaitMs = num("BATON_APPROVAL_WAIT_MS", env.BATON_APPROVAL_WAIT_MS);
  if (env.BATON_QUOTA_RESUME_MARGIN_MS) out.quotaResumeMarginMs = num("BATON_QUOTA_RESUME_MARGIN_MS", env.BATON_QUOTA_RESUME_MARGIN_MS);
  if (env.BATON_CONVERSATION_BREAK_MS) out.conversationBreakMs = num("BATON_CONVERSATION_BREAK_MS", env.BATON_CONVERSATION_BREAK_MS);
  return out;
}

/**
 * 設定を作る。env ファイルの値より環境変数を優先する（launchd は env ファイル、e2e は環境変数だけで起動する）。
 */
export function loadConfig(processEnv: Record<string, string | undefined> = process.env): RunnerConfig {
  let fileEnv: Record<string, string> = {};
  const envFile = processEnv.BATON_ENV_FILE;
  if (envFile) {
    try {
      fileEnv = parseEnvFile(readFileSync(expandHome(envFile), "utf8"));
    } catch (err) {
      throw new Error(`env ファイルを読めません: ${expandHome(envFile)}（${(err as Error).message}）`);
    }
  }
  const env: Record<string, string | undefined> = { ...fileEnv };
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) env[k] = v;

  const batonUrl = (env.BATON_URL ?? "").replace(/\/+$/, "");
  if (!batonUrl) throw new Error("BATON_URL がありません");
  if (!/^https?:\/\//.test(batonUrl)) throw new Error("BATON_URL は http(s):// で始めてください");
  const token = env.BATON_RUNNER_TOKEN ?? "";
  if (!token) throw new Error("BATON_RUNNER_TOKEN がありません");

  const port = Number(env.BATON_LOCAL_PORT ?? "7777");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("BATON_LOCAL_PORT が不正です");

  const home = path.resolve(env.BATON_HOME || homedir());
  const dataDir = path.resolve(expandHome(env.BATON_DATA_DIR || "~/baton-data", home));
  const origins = list(env.BATON_ALLOWED_ORIGINS);
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const modelOverride: Partial<Record<Role, string>> = {};
  for (const role of ["coo", "leader", "member"] as const) {
    const m = env[`BATON_MODEL_${role.toUpperCase()}`];
    if (m) modelOverride[role] = m;
  }
  return {
    batonUrl,
    token,
    runnerName: env.BATON_RUNNER_NAME || "baton-runner",
    dataDir,
    home,
    tailnetUrl: env.BATON_TAILNET_URL ? env.BATON_TAILNET_URL.replace(/\/+$/, "") : null,
    localPort: port,
    allowedTailnetLogins: list(env.ALLOWED_TAILNET_LOGINS),
    allowedOrigins: origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS,
    localAuth: env.BATON_LOCAL_AUTH !== "off",
    version: RUNNER_VERSION,
    limits: applyLimitOverrides(defaultLimits(), env),
    apiRetryDelaysMs: [1000, 4000, 15000],
    claudeBin: expandHome(env.BATON_CLAUDE_BIN || "~/.local/bin/claude", home),
    modelOverride,
    profilesPath: path.resolve(expandHome(env.BATON_PROFILES_PATH || path.join(repoRoot, "runner/profiles/profiles.json"), home)),
    profilesLocalPath: path.join(dataDir, "config/profiles.local.json"),
    extraAllowedDomains: list(env.BATON_EXTRA_ALLOWED_DOMAINS),
    extraBashAllow: list(env.BATON_EXTRA_BASH_ALLOW),
    codexReview: env.BATON_CODEX_REVIEW !== "off",
    codexScript: expandHome(env.BATON_CODEX_SCRIPT || "~/.claude/skills/codex-review/scripts/codex-review.sh", home),
    codexExtensions: list(
      env.BATON_CODEX_EXTENSIONS ||
        ".ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.rb,.java,.kt,.swift,.c,.h,.cpp,.cs,.php,.sh,.sql,.css,.html,.vue,.svelte",
    ),
    projectsScanRoot: path.resolve(expandHome(env.BATON_PROJECTS_ROOT || "~/projects", home)),
    selfRepo: repoRoot,
    transcriptSummaryOnly: env.BATON_TRANSCRIPT_LEVEL === "summary",
    jev: jevConfig(env),
  };
}

// ───────────── データフォルダの配置（4.2・7.3） ─────────────

export const dataPaths = (config: Pick<RunnerConfig, "dataDir">) => {
  const d = config.dataDir;
  return {
    coo: path.join(d, "coo"),
    leader: (slug: string) => path.join(d, "leaders", slug),
    leaders: path.join(d, "leaders"),
    projects: path.join(d, "projects"),
    project: (slug: string) => path.join(d, "projects", slug),
    worktrees: path.join(d, "worktrees"),
    worktree: (id8: string, slug: string, name: string) => path.join(d, "worktrees", id8, slug, name),
    logs: path.join(d, "logs"),
    run: path.join(d, "run"),
    runSession: (sessionId: string) => path.join(d, "run", sessionId),
    profilePlugin: (profile: string) => path.join(d, "run", "profiles", profile, "plugin"),
    config: path.join(d, "config"),
  };
};

/** Baton 専用のプロジェクトの本体（~/baton-data/projects/<slug>） */
export function projectsRoot(config: Pick<RunnerConfig, "dataDir">): string {
  return dataPaths(config).projects;
}

export function workspaceDir(config: Pick<RunnerConfig, "dataDir">, slug: string): string {
  return dataPaths(config).project(slug);
}
