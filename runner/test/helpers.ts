// テストの共通部品。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type RunnerConfig, type RunnerLimits } from "../src/config.ts";
import { LiveLog, silentLogger } from "../src/log.ts";
import type { RunnerDeps } from "../src/orchestrator/context.ts";
import { runInstruction, type RunOutcome } from "../src/orchestrator/run.ts";
import { Semaphore } from "../src/sync.ts";
import { FakeAi, type Rule } from "./fakes/fake-ai.ts";
import { FakeBatonApi } from "./fakes/fake-api.ts";

export async function tempDir(prefix = "baton-runner-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string, limits: Partial<RunnerLimits> = {}, extraEnv: Record<string, string> = {}): RunnerConfig {
  const base = loadConfig({
    BATON_URL: "http://localhost:8790",
    BATON_RUNNER_TOKEN: "test-token",
    BATON_DATA_DIR: dataDir,
    BATON_LOCAL_PORT: "0",
    BATON_RUNNER_NAME: "test-runner",
    ...extraEnv,
  });
  return { ...base, limits: { ...base.limits, ...limits }, aiRetryDelaysMs: [0, 0], apiRetryDelaysMs: [0, 0, 0] };
}

export type Env = {
  dataDir: string;
  config: RunnerConfig;
  ai: FakeAi;
  api: FakeBatonApi;
  deps: RunnerDeps;
  cleanup: () => Promise<void>;
  /** claim して最後まで処理する */
  claimAndRun: (signal?: AbortSignal) => Promise<{ outcome: RunOutcome | null; id: string | null }>;
};

export async function makeEnv(opts: { limits?: Partial<RunnerLimits>; rules?: Rule[]; deps?: Partial<RunnerDeps> } = {}): Promise<Env> {
  const { dir, cleanup } = await tempDir();
  const config = testConfig(dir, opts.limits);
  const ai = new FakeAi();
  if (opts.rules) ai.add(...opts.rules);
  const api = new FakeBatonApi(ai);
  const deps: RunnerDeps = {
    api,
    config,
    aiSemaphore: new Semaphore(config.limits.aiConcurrent),
    log: silentLogger,
    liveLog: new LiveLog(),
    stats: { lastAiError: null },
    ...opts.deps,
  };
  const claimAndRun = async (signal: AbortSignal = new AbortController().signal) => {
    const claim = await api.claim({ maxConcurrent: 2, activeIds: [] });
    if (!claim) return { outcome: null, id: null };
    const outcome = await runInstruction(deps, claim, signal);
    return { outcome, id: claim.instruction.id };
  };
  return { dataDir: dir, config, ai, api, deps, cleanup, claimAndRun };
}
