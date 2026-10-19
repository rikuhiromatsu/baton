// ランナー v2 の起動（DESIGN-v2 2・16.2）。`node src/main.ts` で動く（Node 26 の型除去）。
// 設定は BATON_ENV_FILE の env ファイルと環境変数（環境変数が優先）。SIGTERM/SIGINT で全プロセスに interrupt → lease を外す → 5 秒で終了。
import type http from "node:http";
import { HttpBatonApi, type BatonApi } from "./api.ts";
import { loadProfiles, type ResolvedProfiles } from "./claude/profiles.ts";
import { loadConfig, type RunnerConfig } from "./config.ts";
import { AuthGuard, Coordination, DecisionWaiters, type RunnerContext } from "./context.ts";
import { errorMessage } from "./errors.ts";
import { scanRepos } from "./git/repos.ts";
import { runGit } from "./git/git.ts";
import { createLocalServer, listenLocal } from "./local-server.ts";
import { LiveLog, createLogger, type Logger } from "./log.ts";
import { ThreadPool } from "./orchestrator/thread-pool.ts";
import { QuotaGate } from "./quota.ts";
import { Scheduler, type SchedulerHooks } from "./scheduler.ts";
import { checkClaudeAuth, prepareDataDir, reconcileWorkspaces } from "./startup.ts";
import { StateStore } from "./state.ts";
import { Semaphore } from "./sync.ts";
import { RunnerSocket, type WsFactory } from "./ws.ts";
import path from "node:path";

export type RunnerHandle = {
  ctx: RunnerContext;
  scheduler: Scheduler;
  socket: RunnerSocket;
  server: http.Server;
  localPort: number;
  stop(deadlineMs?: number): Promise<void>;
};

export function createContext(opts: { config: RunnerConfig; log?: Logger; api?: BatonApi; now?: () => number }): RunnerContext {
  const { config } = opts;
  const log = opts.log ?? createLogger();
  const api = opts.api ?? new HttpBatonApi({ baseUrl: config.batonUrl, token: config.token, retryDelaysMs: config.apiRetryDelaysMs });
  let cache: { at: number; value: ResolvedProfiles } | null = null;
  return {
    api,
    config,
    log,
    liveLog: new LiveLog(),
    quota: new QuotaGate(opts.now, config.limits.quotaResumeMarginMs),
    auth: new AuthGuard(),
    decisions: new DecisionWaiters(),
    profiles: async () => {
      // 起動のたびに読み直す（同じ 1 秒の中はまとめる）
      const now = Date.now();
      if (cache && now - cache.at < 1000) return cache.value;
      const value = await loadProfiles(config, cache ? undefined : log);
      cache = { at: now, value };
      return value;
    },
    state: new StateStore(config),
    coord: new Coordination(),
    threads: new ThreadPool(config.limits.threadProcesses, config.limits.threadIdleMs),
    memberSlots: new Semaphore(config.limits.memberProcesses),
    now: opts.now ?? Date.now,
  };
}

/** Baton 自身（リポジトリ候補から外す）: このチェックアウトと、その本体 */
async function selfRepos(config: RunnerConfig): Promise<string[]> {
  const common = (await runGit(["-C", config.selfRepo, "rev-parse", "--git-common-dir"], { allowFail: true })).stdout.trim();
  return [config.selfRepo, ...(common ? [path.dirname(path.resolve(config.selfRepo, common))] : [])];
}

export async function rescanRepos(ctx: RunnerContext): Promise<number> {
  const items = await scanRepos({ root: ctx.config.projectsScanRoot, exclude: await selfRepos(ctx.config) });
  await ctx.api.putRepos({ items });
  return items.length;
}

export async function startRunner(opts: {
  config: RunnerConfig;
  log?: Logger;
  api?: BatonApi;
  wsFactory?: WsFactory;
  hooks?: SchedulerHooks;
  skipAuthCheck?: boolean;
  skipRepoScan?: boolean;
}): Promise<RunnerHandle> {
  const ctx = createContext(opts);
  const { config, log } = ctx;
  await prepareDataDir(ctx);
  await ctx.profiles().catch((err: unknown) => log.error("プロファイルを読めません", { error: errorMessage(err) }));
  if (!opts.skipAuthCheck) await checkClaudeAuth(ctx);
  await reconcileWorkspaces(ctx);

  const rescan = () =>
    void rescanRepos(ctx)
      .then((n) => log.info("リポジトリの候補を送りました", { count: n }))
      .catch((err: unknown) => log.warn("リポジトリの候補を送れません", { error: errorMessage(err) }));
  const scheduler = new Scheduler(ctx, { onRescan: rescan, ...opts.hooks });
  const socket = new RunnerSocket({ batonUrl: config.batonUrl, token: config.token, log, factory: opts.wsFactory, onEvent: (e) => scheduler.onEvent(e) });

  const server = createLocalServer({
    config,
    liveLog: ctx.liveLog,
    log,
    workspace: (id) => ctx.coord.workspaces.get(id),
    status: () => ({
      activeInstructionIds: scheduler.activeInstructionIds(),
      activeThreadIds: scheduler.activeThreadIds(),
      activeSessionIds: scheduler.activeSessionIds(),
      lastHeartbeatAt: scheduler.lastHeartbeatAt,
      hubConnected: socket.connected,
      claudeAuth: ctx.auth.tripped ? "not_subscription" : ctx.auth.authState,
      claudeVersion: ctx.auth.claudeVersion,
      quota: ctx.quota.current,
      authStop: ctx.auth.tripped,
    }),
  });
  const localPort = await listenLocal(server, config.localPort);
  log.info("ランナーを起動しました", { name: config.runnerName, version: config.version, batonUrl: config.batonUrl, dataDir: config.dataDir, claudeBin: config.claudeBin, localPort });

  const authTimer = opts.skipAuthCheck ? null : setInterval(() => void checkClaudeAuth(ctx), config.limits.authCheckIntervalMs);
  authTimer?.unref?.();
  if (!opts.skipRepoScan) rescan();
  socket.start();
  scheduler.start();

  let stopping: Promise<void> | null = null;
  const stop = (deadlineMs = config.limits.shutdownGraceMs) => {
    stopping ??= (async () => {
      log.info("停止します");
      if (authTimer) clearInterval(authTimer);
      socket.close();
      await scheduler.shutdown(deadlineMs);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log.info("停止しました");
    })();
    return stopping;
  };
  return { ctx, scheduler, socket, server, localPort, stop };
}

async function main(): Promise<void> {
  const log = createLogger();
  let config: RunnerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    log.error("設定を読めません", { error: (err as Error).message });
    process.exit(78); // EX_CONFIG
  }
  const handle = await startRunner({ config, log });
  const onSignal = (sig: string) => {
    log.info("シグナルを受けました", { signal: sig });
    const hard = setTimeout(() => process.exit(0), config.limits.shutdownGraceMs + 500);
    hard.unref();
    void handle.stop(config.limits.shutdownGraceMs - 500).finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
