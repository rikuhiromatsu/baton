// R13 ターンの順番（4.5・5.3）: 受信箱はまとめて 1 ターン（[文脈] → 報告・知らせ → [指示の状態] → CEO の発言）、
// 1 スレッドのターンは同時に 1 つ、result のあとのプロセスは待機して次のターンに使い回す（同じセッション ID・新しい起動なし）。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID, parseTurnInput } from "@baton/shared";
import { ThreadPool } from "../src/orchestrator/thread-pool.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R13 ターンの順番", () => {
  it("たまった受信箱を 1 ターンにまとめ、札の並びは [文脈] → 知らせ → CEO", async () => {
    env = await makeEnv();
    await env.api.pushInbox(COO_THREAD_ID, { kind: "instruction_event", wakes: false, payload: { text: "知らせ 1" } });
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    env.api.ceoSays(COO_THREAD_ID, "たすかる");
    await env.step();
    expect(env.api.turnDones).toHaveLength(1);
    expect(env.api.turnDones[0]!.consumedInboxIds).toHaveLength(3);
    const input = env.api.transcript.find((t) => t.kind === "user")!;
    const tags = parseTurnInput(String((input.body as { text: string }).text)).map((l) => l.tag);
    expect(tags).toEqual(["[文脈]", "[知らせ]", "[CEO]", "[CEO]"]);
  }, 30_000);

  it("待機中のプロセスを次のターンに使い回す（init は 1 回、同じセッション ID）", async () => {
    env = await makeEnv({ env: { BATON_THREAD_IDLE_MS: "5000" } });
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    await env.step();
    const first = env.api.turnDones[0]!.sessionId;
    const proc = env.ctx.threads.get(COO_THREAD_ID)!;
    expect(proc.alive).toBe(true);
    const pid = proc.pid;
    env.api.ceoSays(COO_THREAD_ID, "たすかる");
    await env.step();
    expect(env.api.turnDones[1]!.sessionId).toBe(first);
    expect(env.ctx.threads.get(COO_THREAD_ID)!.pid).toBe(pid);
    expect(env.api.sessions.size).toBe(1);
  }, 30_000);

  it("待機時間を過ぎたら閉じ、次は --resume で同じセッション", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    await env.step();
    await new Promise((r) => setTimeout(r, 600));
    expect(env.ctx.threads.get(COO_THREAD_ID)).toBeNull();
    env.api.ceoSays(COO_THREAD_ID, "たすかる");
    await env.step();
    expect(env.api.turnDones[1]!.sessionId).toBe(env.api.turnDones[0]!.sessionId);
    expect(env.api.sessions.size).toBe(1);
  }, 30_000);

  it("num_turns が 400 を超えたら新しいセッション（引き継ぎに直近の発言）", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    await env.step();
    const t = env.api.threads.get(COO_THREAD_ID)!;
    t.sessionTurns = 401;
    env.api.ceoSays(COO_THREAD_ID, "たすかる");
    await env.step();
    expect(env.api.turnDones[1]!.sessionId).not.toBe(env.api.turnDones[0]!.sessionId);
    const handoff = env.api.transcript.filter((t) => t.kind === "user").at(-1)!;
    expect(String((handoff.body as { text: string }).text)).toContain("これまでの会話（新しいセッションへの引き継ぎ）");
  }, 30_000);

  it("ThreadPool: 枠（2）を数え、足りなければ一番古い待機中を閉じる", async () => {
    const closed: string[] = [];
    const fake = (id: string) => ({ sessionId: id, alive: true, close: async () => void closed.push(id), interruptTurn() {} }) as never;
    const pool = new ThreadPool(2, 60_000);
    expect(await pool.reserve()).toBe(true);
    pool.put("a", fake("a"));
    expect(await pool.reserve()).toBe(true);
    pool.put("b", fake("b"));
    expect(pool.hasRoom()).toBe(false);
    pool.idle("a");
    expect(pool.hasRoom()).toBe(true);
    expect(await pool.reserve()).toBe(true);
    expect(closed).toEqual(["a"]);
    pool.unreserve();
    await pool.closeAll();
  });
});
