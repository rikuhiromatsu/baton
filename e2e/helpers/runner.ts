// E2E 用のランナー（runner/src/main.ts）を子プロセスとして起動・停止する道具。
// globalSetup が最初に起動し、E13 がテストの中から止めて再起動し、globalTeardown が止める。
// テストのワーカーは別プロセスなので、トークン・PID・ログ・作業フォルダの場所は RUNNER_STATE_FILE で共有する。
//
// v2: claude は偽物（tools/fake-claude。15.2）を BATON_CLAUDE_BIN で渡す。作業フォルダ（~/baton-data に当たるもの）と
// リポジトリの候補を探す場所（~/projects に当たるもの）は一時フォルダに作り、sample-repo を置く。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_DIR,
  BASE_URL,
  E2E_TIMINGS,
  FAKE_CLAUDE_BIN,
  REPO_ROOT,
  RUNNER_LOCAL_PORT,
  RUNNER_NAME,
  RUNNER_STATE_FILE,
} from "./env.ts";
import { createSampleRepo } from "./git.ts";

/** ランナーのログ（CI では失敗時に artifact として保存する） */
export const RUNNER_LOG_FILE = path.join(AUTH_DIR, "runner.log");

export type RunnerState = {
  token: string;
  runnerId: string;
  /** 一時フォルダの根（後片付けで丸ごと消す） */
  rootDir: string;
  /** BATON_DATA_DIR（本番の ~/baton-data） */
  dataDir: string;
  /** BATON_PROJECTS_ROOT（本番の ~/projects。ランナーが <root>/*\/ と <root>/*\/*\/ を走査する。3.2） */
  projectsRoot: string;
  /** 既存リポジトリの見本（<projectsRoot>/e2e/sample-repo） */
  sampleRepo: string;
  /** FAKE_CLAUDE_STATE_DIR（偽 claude のセッションの保存先） */
  fakeStateDir: string;
  claudeBin: string;
  logFile: string;
  pid: number | null;
};

export function readRunnerState(): RunnerState | null {
  try {
    return JSON.parse(fs.readFileSync(RUNNER_STATE_FILE, "utf8")) as RunnerState;
  } catch {
    return null;
  }
}

export function writeRunnerState(state: RunnerState): void {
  fs.mkdirSync(path.dirname(RUNNER_STATE_FILE), { recursive: true });
  fs.writeFileSync(RUNNER_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function requireRunnerState(): RunnerState {
  const state = readRunnerState();
  if (!state) throw new Error(`ランナーの状態ファイルがありません（${RUNNER_STATE_FILE}）。globalSetup が動いていない`);
  return state;
}

/**
 * 使う claude の実行ファイル。BATON_CLAUDE_BIN（CI の env）があればそれを使うが、偽 claude 以外は受け付けない
 * （本物の claude を E2E で呼ばない。D-60）
 */
export function resolveClaudeBin(): string {
  const bin = path.resolve(process.env.BATON_CLAUDE_BIN ?? FAKE_CLAUDE_BIN);
  if (bin !== FAKE_CLAUDE_BIN) {
    throw new Error(`BATON_CLAUDE_BIN が偽 claude ではありません: ${bin}（E2E は ${FAKE_CLAUDE_BIN} だけを使う）`);
  }
  if (!fs.existsSync(bin)) throw new Error(`偽 claude がありません: ${bin}（tools/fake-claude。V5）`);
  return bin;
}

/** トークンを受け取って新しい状態を作る（作業フォルダ・sample-repo は一時ディレクトリ） */
export function initRunnerState(token: string, runnerId: string): RunnerState {
  // macOS の os.tmpdir() はシンボリックリンク（/var → /private/var）なので実体にそろえる（ランナーは realpath で検査する。7.5）
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "baton-e2e-")));
  const dataDir = path.join(rootDir, "baton-data");
  const projectsRoot = path.join(rootDir, "projects");
  const fakeStateDir = path.join(rootDir, "fake-claude");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(fakeStateDir, { recursive: true });
  const sampleRepo = createSampleRepo(path.join(projectsRoot, "e2e", "sample-repo"));
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(RUNNER_LOG_FILE, "");
  const state: RunnerState = {
    token,
    runnerId,
    rootDir,
    dataDir,
    projectsRoot,
    sampleRepo,
    fakeStateDir,
    claudeBin: resolveClaudeBin(),
    logFile: RUNNER_LOG_FILE,
    pid: null,
  };
  writeRunnerState(state);
  return state;
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isRunnerRunning(): boolean {
  return isAlive(readRunnerState()?.pid);
}

/** 子プロセスに渡さない環境変数（本物の claude・API キー・本番の設定に繋がるもの。7.7） */
const DROP_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|BATON_ENV_FILE$|GH_TOKEN$|GITHUB_TOKEN$|CLOUDFLARE_)/;

export function runnerEnv(state: RunnerState): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.test(k)) env[k] = v;
  return {
    ...env,
    BATON_URL: BASE_URL,
    BATON_RUNNER_TOKEN: state.token,
    BATON_DATA_DIR: state.dataDir,
    BATON_PROJECTS_ROOT: state.projectsRoot,
    BATON_LOCAL_PORT: String(RUNNER_LOCAL_PORT),
    BATON_RUNNER_NAME: RUNNER_NAME,
    BATON_TAILNET_URL: `http://127.0.0.1:${RUNNER_LOCAL_PORT}`,
    BATON_LOCAL_AUTH: "off",
    BATON_ALLOWED_ORIGINS: BASE_URL,
    // 偽 claude（15.2）
    BATON_CLAUDE_BIN: state.claudeBin,
    FAKE_CLAUDE_STATE_DIR: state.fakeStateDir,
    FAKE_QUOTA_RESET_SEC: String(E2E_TIMINGS.fakeQuotaResetSec),
    // E2E 用に短くした時間（15.3）
    BATON_APPROVAL_WAIT_MS: String(E2E_TIMINGS.approvalWaitMs),
    BATON_THREAD_IDLE_MS: String(E2E_TIMINGS.threadIdleMs),
    BATON_CONVERSATION_BREAK_MS: String(E2E_TIMINGS.conversationBreakMs),
    BATON_QUOTA_RESUME_MARGIN_MS: String(E2E_TIMINGS.quotaResumeMarginMs),
    // Codex レビューは回さない（本人の OpenAI の枠を使うため。6.4）。sample-repo のフックも本人の設定も読まない
    BATON_CODEX_REVIEW: "off",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** ランナーを起動する。既に動いていれば何もしない */
export function startRunner(): number {
  const state = requireRunnerState();
  if (isAlive(state.pid)) return state.pid!;
  const log = fs.openSync(state.logFile, "a");
  const child = spawn(process.execPath, ["runner/src/main.ts"], {
    cwd: REPO_ROOT,
    // 親（globalSetup やテストのワーカー）が先に終わっても止まらないように切り離す。止めるのは stopRunner
    detached: true,
    stdio: ["ignore", log, log],
    env: runnerEnv(state),
  });
  fs.closeSync(log);
  child.unref();
  if (!child.pid) throw new Error("ランナーを起動できませんでした");
  writeRunnerState({ ...state, pid: child.pid });
  return child.pid;
}

/** ランナーを止める（SIGTERM → 15 秒待って SIGKILL）。5.7 のとおり全プロセスに interrupt → lease を外す → 5 秒で打ち切り */
export async function stopRunner(): Promise<void> {
  const state = readRunnerState();
  if (!state) return;
  const pid = state.pid;
  if (isAlive(pid)) {
    signal(pid!, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(100);
    if (isAlive(pid)) signal(pid!, "SIGKILL");
    while (isAlive(pid)) await sleep(50);
  }
  writeRunnerState({ ...state, pid: null });
}

/** 止めてから起動し直す */
export async function restartRunner(): Promise<number> {
  await stopRunner();
  return startRunner();
}

/** 失敗の調べ物用に、ランナーのログの末尾を返す */
export function runnerLogTail(lines = 80): string {
  const state = readRunnerState();
  if (!state) return "";
  try {
    return fs.readFileSync(state.logFile, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Baton 専用のプロジェクトの本体（7.3: <DATA>/projects/<slug>/） */
export function batonProjectDir(slug: string): string {
  return path.join(requireRunnerState().dataDir, "projects", slug);
}

/** 指示の worktree の置き場所（7.3: <DATA>/worktrees/<id8>/） */
export function instructionWorktreesDir(instructionId: string): string {
  return path.join(requireRunnerState().dataDir, "worktrees", instructionId.slice(0, 8));
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    // detached で起動したのでプロセスグループごと送る（偽 claude の子プロセスも残さない）
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* もういない */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
