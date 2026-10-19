// 設定の読み込み。BATON_ENV_FILE の env ファイル → 環境変数の順に読み、環境変数が優先。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { LIMITS } from "@baton/shared";

export const RUNNER_VERSION = "0.1.0";

export const DEFAULT_ALLOWED_ORIGINS = ["https://baton.rikuhiromatsu.workers.dev", "http://localhost:8790"];

/** ランナーが使う上限。shared の LIMITS を元に、環境変数 BATON_LIMIT_<名前> で上書きできる */
export type RunnerLimits = {
  runnerConcurrentInstructions: number;
  memberParallel: number;
  aiConcurrent: number;
  aiCallsPerInstruction: number;
  tokensPerInstruction: number;
  memberTurns: number;
  maxRounds: number;
  instructionWallClockMs: number;
  aiCallTimeoutMs: number;
  memberRecentTurns: number;
  memberToolResultChars: number;
  decisionsPerInstruction: number;
  heartbeatIntervalMs: number;
  claimPollIntervalMs: number;
  fsReadMaxChars: number;
  fsListMax: number;
  fsWriteMaxBytes: number;
  fsWritesPerInstruction: number;
  fsWriteTotalBytesPerInstruction: number;
  webFetchTimeoutMs: number;
  webFetchMaxBytes: number;
  webFetchMaxChars: number;
  webFetchMaxRedirects: number;
  webFetchPerInstruction: number;
  eventContentMaxChars: number;
  artifactPreviewMaxChars: number;
  eventsPerAppend: number;
  maxCompletionTokens: { coo: number; leader: number; member: number; util: number };
};

export function defaultLimits(): RunnerLimits {
  return {
    runnerConcurrentInstructions: LIMITS.runnerConcurrentInstructions,
    memberParallel: LIMITS.memberParallel,
    aiConcurrent: LIMITS.aiConcurrent,
    aiCallsPerInstruction: LIMITS.aiCallsPerInstruction,
    tokensPerInstruction: LIMITS.tokensPerInstruction,
    memberTurns: LIMITS.memberTurns,
    maxRounds: LIMITS.maxRounds,
    instructionWallClockMs: LIMITS.instructionWallClockMs,
    aiCallTimeoutMs: LIMITS.aiCallTimeoutMs,
    memberRecentTurns: LIMITS.memberRecentTurns,
    memberToolResultChars: LIMITS.memberToolResultChars,
    decisionsPerInstruction: LIMITS.decisionsPerInstruction,
    heartbeatIntervalMs: LIMITS.heartbeatIntervalMs,
    claimPollIntervalMs: LIMITS.claimPollIntervalMs,
    fsReadMaxChars: LIMITS.fsReadMaxChars,
    fsListMax: LIMITS.fsListMax,
    fsWriteMaxBytes: LIMITS.fsWriteMaxBytes,
    fsWritesPerInstruction: LIMITS.fsWritesPerInstruction,
    fsWriteTotalBytesPerInstruction: LIMITS.fsWriteTotalBytesPerInstruction,
    webFetchTimeoutMs: LIMITS.webFetchTimeoutMs,
    webFetchMaxBytes: LIMITS.webFetchMaxBytes,
    webFetchMaxChars: LIMITS.webFetchMaxChars,
    webFetchMaxRedirects: LIMITS.webFetchMaxRedirects,
    webFetchPerInstruction: LIMITS.webFetchPerInstruction,
    eventContentMaxChars: LIMITS.eventContentMaxChars,
    artifactPreviewMaxChars: LIMITS.artifactPreviewMaxChars,
    eventsPerAppend: LIMITS.eventsPerAppend,
    maxCompletionTokens: { ...LIMITS.maxCompletionTokens },
  };
}

export type RunnerConfig = {
  batonUrl: string;
  token: string;
  runnerName: string;
  dataDir: string;
  tailnetUrl: string | null;
  localPort: number;
  allowedTailnetLogins: string[];
  allowedOrigins: string[];
  /** false のとき local-server は Tailscale-User-Login を検査しない（e2e 専用） */
  localAuth: boolean;
  version: string;
  limits: RunnerLimits;
  /** ランナー → Worker の API の再試行間隔（5.6: 1 秒・4 秒・15 秒） */
  apiRetryDelaysMs: number[];
  /** AI 呼び出しの再試行間隔（5.6: 2 秒→8 秒）。その後に退避先で 1 回 */
  aiRetryDelaysMs: number[];
};

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

export function applyLimitOverrides(base: RunnerLimits, env: Record<string, string | undefined>): RunnerLimits {
  const out: RunnerLimits = { ...base, maxCompletionTokens: { ...base.maxCompletionTokens } };
  for (const key of Object.keys(out) as (keyof RunnerLimits)[]) {
    if (key === "maxCompletionTokens") continue;
    const v = env[toEnvName(key)];
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${toEnvName(key)} は 0 以上の数値にしてください`);
    (out[key] as number) = n;
  }
  // 互換の短い名前
  if (env.BATON_MAX_CONCURRENT) out.runnerConcurrentInstructions = Number(env.BATON_MAX_CONCURRENT);
  out.runnerConcurrentInstructions = Math.min(4, Math.max(1, Math.floor(out.runnerConcurrentInstructions)));
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

  const origins = list(env.BATON_ALLOWED_ORIGINS);
  return {
    batonUrl,
    token,
    runnerName: env.BATON_RUNNER_NAME || "baton-runner",
    dataDir: path.resolve(expandHome(env.BATON_DATA_DIR || "~/baton-data")),
    tailnetUrl: env.BATON_TAILNET_URL ? env.BATON_TAILNET_URL.replace(/\/+$/, "") : null,
    localPort: port,
    allowedTailnetLogins: list(env.ALLOWED_TAILNET_LOGINS),
    allowedOrigins: origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS,
    localAuth: env.BATON_LOCAL_AUTH !== "off",
    version: RUNNER_VERSION,
    limits: applyLimitOverrides(defaultLimits(), env),
    apiRetryDelaysMs: [1000, 4000, 15000],
    aiRetryDelaysMs: [2000, 8000],
  };
}

/** 作業フォルダのルート（~/baton-data/projects） */
export function projectsRoot(config: Pick<RunnerConfig, "dataDir">): string {
  return path.join(config.dataDir, "projects");
}

export function workspaceDir(config: Pick<RunnerConfig, "dataDir">, slug: string): string {
  return path.join(projectsRoot(config), slug);
}
