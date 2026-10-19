// R9 取消・中断（5.7・D-67）: 取消はメンバーに interrupt → 閉じる → SIGTERM、worktree は残す。
// メンバーの中断は paused（interrupted）と「再開」の判断。スレッドの中断は発言を canceled（本文は残す）。
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { StopSignal } from "../src/errors.ts";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

async function toMembers(e: Env, text: string) {
  e.api.ceoSays(COO_THREAD_ID, text);
  await e.step();
  await e.step();
}

describe("R9 取消と中断", () => {
  it("取消: 動いているメンバーを止め、セッションとタスクは canceled、worktree は残る", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_CLAUDE_SLOW_MS: "400" } });
    await toMembers(env, "長い作業 [slow@member]");
    const ac = new AbortController();
    const run = env.step(ac.signal);
    await waitFor(() => [...env.api.sessions.values()].some((s) => s.role === "member" && s.status === "running"));
    const started = Date.now();
    ac.abort(new StopSignal("cancel"));
    await run;
    expect(Date.now() - started).toBeLessThan(9000);
    const s = [...env.api.sessions.values()].find((s) => s.role === "member")!;
    expect(s.status).toBe("canceled");
    expect([...env.api.tasks.values()][0]!.status).toBe("canceled");
    const ws = [...env.api.workspaces.values()].find((w) => w.purpose === "task")!;
    expect(existsSync(ws.worktreePath)).toBe(true);
    expect(env.ctx.coord.memberSessions.size).toBe(0);
  }, 30_000);

  it("メンバーの中断: interrupt → paused（interrupted）と判断 → 回答で同じセッションを --resume", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_CLAUDE_SLOW_MS: "300" } });
    await toMembers(env, "長い作業 [slow@member]");
    const run = env.step();
    await waitFor(() => env.ctx.coord.memberSessions.size > 0 && [...env.api.transcript].some((t) => t.kind === "tool_use"));
    const [sid, live] = [...env.ctx.coord.memberSessions.entries()][0]!;
    live.interrupt();
    await run;
    expect(env.api.sessions.get(sid)!.status).toBe("paused");
    expect(env.api.sessions.get(sid)!.pauseReason).toBe("interrupted");
    const d = [...env.api.decisions.values()].find((d) => d.kind === "interrupted")!;
    expect(d.question).toContain("中断");
    expect(env.api.transcript.some((t) => t.sessionId === sid && t.summary === "中断")).toBe(true);
    env.api.answerDecision(d.id, null, "続けて");
    await env.step();
    expect(env.api.sessions.get(sid)!.status).toBe("done");
  }, 40_000);

  it("スレッドの中断: 発言は canceled、受信箱は消化", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_CLAUDE_SLOW_MS: "300", FAKE_CLAUDE_SLOW_DELTA_MS: "50" } });
    env.api.ceoSays(COO_THREAD_ID, "[slow] [long] 長い返事をして");
    const run = env.step();
    await waitFor(() => env.ctx.threads.activeThreadIds().includes(COO_THREAD_ID) && env.api.streams.length > 0);
    expect(env.ctx.threads.interrupt(COO_THREAD_ID)).toBe(true);
    const r = await run;
    expect(r?.outcome).toBe("interrupted");
    const m = env.api.messagesOf(COO_THREAD_ID).find((m) => m.authorKind === "coo")!;
    expect(m.status).toBe("canceled");
    expect(env.api.pendingInbox(COO_THREAD_ID)).toHaveLength(0);
  }, 30_000);
});
