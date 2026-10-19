// テストの共通部品: 一時フォルダ・設定・偽 claude（tools/fake-claude）・偽 Worker（FakeBatonApi）・claim を回し切る道具。
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type RunnerConfig } from "../src/config.ts";
import type { RunnerContext } from "../src/context.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { createContext } from "../src/main.ts";
import { runFinalize } from "../src/orchestrator/finalize.ts";
import { runInstructionPhase } from "../src/orchestrator/instruction.ts";
import { runThreadTurn } from "../src/orchestrator/thread.ts";
import { FakeBatonApi } from "./fakes/fake-api.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
export const FAKE_CLAUDE = path.join(REPO_ROOT, "tools/fake-claude/bin/claude");

export async function tempDir(prefix = "baton-runner-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string, extraEnv: Record<string, string> = {}): RunnerConfig {
  const base = loadConfig({
    BATON_URL: "http://localhost:8790",
    BATON_RUNNER_TOKEN: "test-token",
    BATON_DATA_DIR: dataDir,
    BATON_LOCAL_PORT: "0",
    BATON_RUNNER_NAME: "test-runner",
    ...extraEnv,
  });
  return {
    ...base,
    apiRetryDelaysMs: [0, 0, 0],
    limits: { ...base.limits, transcriptFlushMs: 5, streamFlushMs: 5, threadIdleMs: extraEnv.BATON_THREAD_IDLE_MS ? base.limits.threadIdleMs : 200, gitLockRetryDelaysMs: [10, 20, 30] },
  };
}

/** 本人のホームに当たるもの（CLAUDE.md・スキル・projects） */
export async function makeHome(root: string): Promise<string> {
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".claude/skills"), { recursive: true });
  await mkdir(path.join(home, "projects"), { recursive: true });
  await writeFile(
    path.join(home, ".claude/CLAUDE.md"),
    "# 全プロジェクト共通ルール\n\n## 返答の言語\n\nユーザーに見える文はすべて日本語で書く。\n\n## Codex によるクロスレビュー\n\n必ず codex-review スキルで。\n\n## MBA から送られた画像\n\n~/.cache を読む。\n",
  );
  for (const name of ["sns-url-research", "prior-art-search", "linear-task"]) {
    await mkdir(path.join(home, ".claude/skills", name), { recursive: true });
    await writeFile(path.join(home, ".claude/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: テスト用の ${name}\n---\n\n本文\n`);
  }
  return home;
}

export type Env = {
  dir: string;
  home: string;
  dataDir: string;
  config: RunnerConfig;
  api: FakeBatonApi;
  ctx: RunnerContext;
  cleanup: () => Promise<void>;
  /** claim を 1 回して回す（無ければ null） */
  step: (signal?: AbortSignal) => Promise<{ kind: string; outcome: string } | null>;
  /** 仕事が無くなるまで回す */
  drain: (max?: number) => Promise<{ kind: string; outcome: string }[]>;
};

export async function makeEnv(opts: { env?: Record<string, string>; log?: Logger; fakeEnv?: Record<string, string> } = {}): Promise<Env> {
  const { dir, cleanup } = await tempDir();
  const home = await makeHome(dir);
  const dataDir = path.join(dir, "baton-data");
  // 偽 claude の設定（子の環境は FAKE_* だけ通る）
  process.env.FAKE_CLAUDE_STATE_DIR = path.join(dir, "fake-state");
  process.env.FAKE_CLAUDE_STEP_MS = "0";
  process.env.FAKE_CLAUDE_DELTA_MS = "0";
  for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_") && !["FAKE_CLAUDE_STATE_DIR", "FAKE_CLAUDE_STEP_MS", "FAKE_CLAUDE_DELTA_MS"].includes(k)) delete process.env[k];
  for (const [k, v] of Object.entries(opts.fakeEnv ?? {})) process.env[k] = v;
  const config = testConfig(dataDir, {
    BATON_HOME: home,
    BATON_CLAUDE_BIN: FAKE_CLAUDE,
    BATON_PROJECTS_ROOT: path.join(home, "projects"),
    BATON_CODEX_REVIEW: "off",
    ...opts.env,
  });
  const api = new FakeBatonApi();
  const ctx = createContext({ config, log: opts.log ?? silentLogger, api });
  const { prepareDataDir } = await import("../src/startup.ts");
  await prepareDataDir(ctx);
  const step = async (signal: AbortSignal = new AbortController().signal) => {
    const claim = await api.claim({
      kinds: ["thread", "instruction", "finalize"],
      activeThreadIds: [],
      activeInstructionIds: [],
      quotaPaused: !ctx.quota.canStartMember(),
    });
    if (!claim) return null;
    if (claim.kind === "thread") return { kind: "thread", outcome: await runThreadTurn(ctx, claim, signal) };
    if (claim.kind === "instruction") {
      const outcome = await runInstructionPhase(ctx, claim, signal);
      api.unlease(claim.instruction.id);
      return { kind: "instruction", outcome };
    }
    return { kind: "finalize", outcome: await runFinalize(ctx, claim) };
  };
  const drain = async (max = 40) => {
    const out: { kind: string; outcome: string }[] = [];
    for (let i = 0; i < max; i++) {
      const r = await step();
      if (!r) break;
      out.push(r);
    }
    return out;
  };
  return {
    dir,
    home,
    dataDir,
    config,
    api,
    ctx,
    cleanup: async () => {
      await ctx.threads.closeAll();
      await cleanup();
    },
    step,
    drain,
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

/** 既存リポジトリの見本（未コミットの変更・失敗するフック・別のブランチをチェックアウト中） */
export async function makeSampleRepo(root: string, name = "sample-repo"): Promise<string> {
  const repo = path.join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.com");
  await writeFile(path.join(repo, "README.md"), "# sample\n");
  await writeFile(path.join(repo, "CLAUDE.md"), "# サンプルの決まり\nテストを書くこと。\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

export function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: 時間切れ"));
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}
