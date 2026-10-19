// ランナーの起動（設計書 9.1）。`node src/main.ts` で動く（Node 26 の型除去）。
// 設定は BATON_ENV_FILE の env ファイルと環境変数（環境変数が優先）。SIGTERM/SIGINT で実行中の指示を release してから 5 秒以内に終了する。
import { mkdir } from "node:fs/promises";
import type http from "node:http";
import { HttpBatonApi, type BatonApi } from "./api.ts";
import { loadConfig, projectsRoot, type RunnerConfig } from "./config.ts";
import { createLocalServer, listenLocal } from "./local-server.ts";
import { LiveLog, createLogger, type Logger } from "./log.ts";
import type { RunnerDeps, RunnerStats } from "./orchestrator/context.ts";
import { runInstruction } from "./orchestrator/run.ts";
import { Scheduler } from "./scheduler.ts";
import { Semaphore } from "./sync.ts";
import { RunnerSocket, type WsFactory } from "./ws.ts";

export type RunnerHandle = {
  scheduler: Scheduler;
  socket: RunnerSocket;
  server: http.Server;
  localPort: number;
  stop(deadlineMs?: number): Promise<void>;
};

export async function startRunner(opts: {
  config: RunnerConfig;
  log?: Logger;
  api?: BatonApi;
  wsFactory?: WsFactory;
  deps?: Partial<Pick<RunnerDeps, "lookup" | "transport" | "now">>;
}): Promise<RunnerHandle> {
  const { config } = opts;
  const log = opts.log ?? createLogger();
  const api =
    opts.api ??
    new HttpBatonApi({ baseUrl: config.batonUrl, token: config.token, retryDelaysMs: config.apiRetryDelaysMs, aiTimeoutMs: config.limits.aiCallTimeoutMs });
  const liveLog = new LiveLog();
  const stats: RunnerStats = { lastAiError: null };
  await mkdir(projectsRoot(config), { recursive: true });

  const deps: RunnerDeps = {
    api,
    config,
    aiSemaphore: new Semaphore(config.limits.aiConcurrent),
    log,
    liveLog,
    stats,
    ...opts.deps,
  };
  const scheduler = new Scheduler({ api, config, log, run: (claim, signal) => runInstruction(deps, claim, signal) });

  const socket = new RunnerSocket({
    batonUrl: config.batonUrl,
    token: config.token,
    log,
    factory: opts.wsFactory,
    onEvent: (e) => {
      if (e.t === "work.available" || e.t === "decision.answered") scheduler.poke();
      else if (e.t === "instruction.cancel") scheduler.cancel(e.instructionId);
    },
  });

  const server = createLocalServer({
    config,
    liveLog,
    log,
    stats,
    status: () => ({
      activeInstructionIds: scheduler.activeIds(),
      maxConcurrent: scheduler.maxConcurrent,
      lastHeartbeatAt: scheduler.lastHeartbeatAt,
      hubConnected: socket.connected,
    }),
  });
  const localPort = await listenLocal(server, config.localPort);
  log.info("ランナーを起動しました", {
    name: config.runnerName,
    version: config.version,
    batonUrl: config.batonUrl,
    dataDir: config.dataDir,
    localPort,
    localAuth: config.localAuth,
  });

  socket.start();
  scheduler.start();

  let stopping: Promise<void> | null = null;
  const stop = (deadlineMs = 5000) => {
    stopping ??= (async () => {
      log.info("停止します");
      socket.close();
      await scheduler.shutdown(deadlineMs);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log.info("停止しました");
    })();
    return stopping;
  };
  return { scheduler, socket, server, localPort, stop };
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
    // 5 秒で必ず終える
    const hard = setTimeout(() => process.exit(0), 5000);
    hard.unref();
    void handle.stop(4500).finally(() => process.exit(0));
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
