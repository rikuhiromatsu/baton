// モックの入口（?mock=1 のときだけ main.tsx が動的 import する。テストもここから使う）
// ?scenario=a でシナリオ A（14.1）を時間差で再生、?still=1 で動いている作業を途中で止めた絵にする
import { MockBackend, type MockOptions } from "./mock/backend.ts";
import { installRest } from "./mock/rest.ts";
import { installScript, type Flows } from "./mock/script.ts";
import { playScenarioA, seedFull, seedScenario, seedStatic } from "./mock/seed.ts";

export { MockBackend, MockSocket } from "./mock/backend.ts";
export type { MockOptions } from "./mock/backend.ts";

export type MockHandle = { backend: MockBackend; flows: Flows; playScenarioA: () => Promise<void> };

export function createMock(opts: MockOptions = {}): MockHandle {
  const backend = new MockBackend(opts);
  installRest(backend);
  const flows = installScript(backend);
  if (opts.empty) {
    seedStatic(backend);
  } else if (opts.scenario === "a") {
    backend.ready = seedScenario(backend);
  } else {
    backend.ready = seedFull(backend, flows, { still: opts.still ?? false });
  }
  const handle: MockHandle = {
    backend,
    flows,
    playScenarioA: () => playScenarioA(backend, flows),
  };
  if (opts.scenario === "a") backend.run(() => backend.ready.then(() => handle.playScenarioA()));
  return handle;
}

/** 生ログ（SSE）の代わり。数百 ms ごとに行を流す */
export function mockRawLog(_url: string, onLine: (line: string) => void): { close(): void } {
  const lines = ["[runner] claim kind=thread", "[coo] turn start", "[leader] plan tasks=2", "[member:t1] Write research/topics.md", "[member:t2] done", "[coo] present"];
  let i = 0;
  const timer = setInterval(() => {
    onLine(`${new Date().toISOString().slice(11, 19)} ${lines[i % lines.length]}`);
    i += 1;
  }, 600);
  return { close: () => clearInterval(timer) };
}
