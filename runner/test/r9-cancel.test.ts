// R9 instruction.cancel で実行中の AI 呼び出しと道具が中断され、それ以降 API を呼ばない。
import { afterEach, describe, expect, it } from "vitest";
import { StopSignal } from "../src/errors.ts";
import { runInstruction } from "../src/orchestrator/run.ts";
import { Scheduler } from "../src/scheduler.ts";
import { silentLogger } from "../src/log.ts";
import type { Transport } from "../src/tools/web-fetch.ts";
import { J, hang, isStage, normalRules, taskKeyOf } from "./fakes/fake-ai.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(() => env?.cleanup());

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup() {
  let fetchStarted = false;
  let fetchAborted = false;
  const transport: Transport = (_url, { signal }) =>
    new Promise((_, reject) => {
      fetchStarted = true;
      signal.addEventListener(
        "abort",
        () => {
          fetchAborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const rules = [
    ...normalRules().filter((r) => ["route", "plan"].includes(r.name ?? "")),
    { match: isStage("member_step", (i) => taskKeyOf(i) === "t1"), reply: hang },
    { match: isStage("member_step", (i) => taskKeyOf(i) === "t2"), reply: J({ kind: "tool", tool: "web_fetch", args: { url: "http://example.com/slow" }, why: "取得" }) },
  ];
  return { transport, rules, state: () => ({ fetchStarted, fetchAborted }) };
}

describe("R9 取消", () => {
  it("AbortController で AI 呼び出しと web_fetch を止め、それ以降 API を呼ばない", async () => {
    const s = setup();
    env = await makeEnv({ rules: s.rules, deps: { transport: s.transport, lookup: async () => [{ address: "93.184.216.34", family: 4 }] } });
    const id = env.api.addInstruction("止められる指示");
    const claim = (await env.api.claim({ maxConcurrent: 2, activeIds: [] }))!;
    const controller = new AbortController();
    const running = runInstruction(env.deps, claim, controller.signal);
    await waitFor(() => env.ai.inFlight === 1 && s.state().fetchStarted);

    env.api.cancelByCeo(id);
    const abortedAt = performance.now();
    controller.abort(new StopSignal("cancel"));
    expect(await running).toBe("stopped");
    await new Promise((r) => setTimeout(r, 50));

    expect(env.ai.aborted).toBe(1);
    expect(s.state().fetchAborted).toBe(true);
    expect(env.api.callsAfter(abortedAt, id)).toEqual([]);
    expect(env.api.inst(id).status).toBe("canceled");
    expect(env.api.releases).toHaveLength(0);
  });

  it("ハートビートの cancelInstructionIds と WebSocket の instruction.cancel で scheduler が止める", async () => {
    const s = setup();
    env = await makeEnv({ rules: s.rules, deps: { transport: s.transport, lookup: async () => [{ address: "93.184.216.34", family: 4 }] } });
    const id = env.api.addInstruction("止められる指示");
    const outcomes: unknown[] = [];
    const scheduler = new Scheduler({
      api: env.api,
      config: { ...env.config, limits: { ...env.config.limits, claimPollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 } },
      log: silentLogger,
      run: async (claim, signal) => {
        const o = await runInstruction(env.deps, claim, signal);
        outcomes.push(o);
        return o;
      },
    });
    scheduler.start();
    try {
      await waitFor(() => env.ai.inFlight === 1 && s.state().fetchStarted);
      expect(scheduler.activeIds()).toEqual([id]);
      env.api.cancelByCeo(id);
      await scheduler.heartbeat();
      await waitFor(() => outcomes.length === 1);
      expect(outcomes).toEqual(["stopped"]);
      expect(scheduler.activeIds()).toEqual([]);
      expect(env.api.heartbeats.some((h) => h.activeInstructionIds.includes(id))).toBe(true);
    } finally {
      await scheduler.shutdown(500);
    }
    expect(env.api.releases).toHaveLength(0); // 取消したものは release しない
  });

  it("scheduler は同時実行 2 件まで取り出す", async () => {
    env = await makeEnv({ rules: [{ match: isStage("coo_route"), reply: hang, times: 10 }] });
    const ids = [env.api.addInstruction("1"), env.api.addInstruction("2"), env.api.addInstruction("3")];
    const scheduler = new Scheduler({
      api: env.api,
      config: { ...env.config, limits: { ...env.config.limits, claimPollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 } },
      log: silentLogger,
      run: (claim, signal) => runInstruction(env.deps, claim, signal),
    });
    scheduler.start();
    try {
      await waitFor(() => env.ai.inFlight === 2);
      scheduler.poke();
      await new Promise((r) => setTimeout(r, 30));
      expect(scheduler.activeIds().sort()).toEqual(ids.slice(0, 2).sort());
      expect(env.api.inst(ids[2]!).status).toBe("queued");
      scheduler.cancel(ids[0]!);
      await waitFor(() => scheduler.activeIds().includes(ids[2]!));
    } finally {
      await scheduler.shutdown(1000);
    }
  });
});
