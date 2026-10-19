// E2E 用のランナー（runner/src/main.ts）を子プロセスとして起動・停止する道具。
// globalSetup が最初に起動し、E13 がテストの中から止めて再起動し、globalTeardown が止める。
// テストのワーカーは別プロセスなので、トークン・PID・ログの場所は RUNNER_STATE_FILE で共有する。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_DIR, BASE_URL, REPO_ROOT, RUNNER_LOCAL_PORT, RUNNER_NAME, RUNNER_STATE_FILE } from "./env.ts";

/** ランナーのログ（CI では失敗時に artifact として保存する） */
export const RUNNER_LOG_FILE = path.join(AUTH_DIR, "runner.log");

export type RunnerState = {
  token: string;
  runnerId: string;
  dataDir: string;
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

function requireState(): RunnerState {
  const state = readRunnerState();
  if (!state) throw new Error(`ランナーの状態ファイルがありません（${RUNNER_STATE_FILE}）。globalSetup が動いていない`);
  return state;
}

/** トークンを受け取って新しい状態を作る（作業フォルダは一時ディレクトリ） */
export function initRunnerState(token: string, runnerId: string): RunnerState {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-e2e-data-"));
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(RUNNER_LOG_FILE, "");
  const state: RunnerState = { token, runnerId, dataDir, logFile: RUNNER_LOG_FILE, pid: null };
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

/** ランナーを起動する。既に動いていれば何もしない */
export function startRunner(): number {
  const state = requireState();
  if (isAlive(state.pid)) return state.pid!;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BATON_URL: BASE_URL,
    BATON_RUNNER_TOKEN: state.token,
    BATON_DATA_DIR: state.dataDir,
    BATON_LOCAL_PORT: String(RUNNER_LOCAL_PORT),
    BATON_RUNNER_NAME: RUNNER_NAME,
    BATON_TAILNET_URL: `http://127.0.0.1:${RUNNER_LOCAL_PORT}`,
    BATON_LOCAL_AUTH: "off",
    BATON_ALLOWED_ORIGINS: BASE_URL,
  };
  // 本番用の設定ファイル（~/.config/baton/runner.env）を読ませない
  delete env.BATON_ENV_FILE;
  const log = fs.openSync(state.logFile, "a");
  const child = spawn(process.execPath, ["runner/src/main.ts"], {
    cwd: REPO_ROOT,
    // 親（globalSetup やテストのワーカー）が先に終わっても止まらないように切り離す。止めるのは stopRunner
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  fs.closeSync(log);
  child.unref();
  if (!child.pid) throw new Error("ランナーを起動できませんでした");
  writeRunnerState({ ...state, pid: child.pid });
  return child.pid;
}

/** ランナーを止める（SIGTERM → 10 秒待って SIGKILL）。設計書 5.9 のとおり SIGTERM で release してから終わる */
export async function stopRunner(): Promise<void> {
  const state = readRunnerState();
  if (!state) return;
  const pid = state.pid;
  if (isAlive(pid)) {
    signal(pid!, "SIGTERM");
    const deadline = Date.now() + 10_000;
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

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    // detached で起動したのでプロセスグループごと送る（子プロセスを残さない）
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
