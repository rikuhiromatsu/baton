// R6 落ちた想定と worktree の引き継ぎ（5.5・7.5）: running のまま残ったメンバーは同じ cwd で --resume「ランナーが再起動した」。
// --resume できなければ新しいセッションに「前任の変更が残っている。git status で確かめて続けて」。worktree が消えていればブランチから作り直す。
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { StopSignal } from "../src/errors.ts";
import { createContext } from "../src/main.ts";
import { silentLogger } from "../src/log.ts";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

/** メンバーが動いている途中でランナーが止まった状態を作る */
async function crashMidMember(e: Env): Promise<string> {
  e.api.ceoSays(COO_THREAD_ID, "長い作業 [slow@member]");
  await e.step();
  await e.step();
  const ac = new AbortController();
  const run = e.step(ac.signal);
  await waitFor(() => e.api.transcript.some((t) => t.kind === "tool_use" && e.api.sessions.get(t.sessionId)?.role === "member"));
  ac.abort(new StopSignal("shutdown"));
  await run;
  const s = [...e.api.sessions.values()].find((x) => x.role === "member")!;
  expect(s.status).toBe("running");
  // 新しいランナー（同じデータフォルダ・同じ Worker）
  e.ctx = createContext({ config: e.config, log: silentLogger, api: e.api });
  return s.id;
}

describe("R6 再起動での引き継ぎ", () => {
  it("running のまま残ったメンバーを同じセッション・同じ cwd で --resume して終える", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_CLAUDE_SLOW_MS: "200" } });
    const sid = await crashMidMember(env);
    const ws = [...env.api.workspaces.values()].find((w) => w.purpose === "task")!;
    // worktree が消えていてもブランチから作り直す
    await rm(ws.worktreePath, { recursive: true, force: true });
    const { prepareDataDir } = await import("../src/startup.ts");
    await prepareDataDir(env.ctx);
    const r = await env.step();
    expect(r?.kind).toBe("instruction");
    expect(env.api.sessions.get(sid)!.status).toBe("done");
    expect(env.api.transcript.some((t) => t.sessionId === sid && String((t.body as { text?: string }).text ?? "").includes("[ランナー] ランナーが再起動した"))).toBe(true);
    expect(env.api.transcript.some((t) => t.sessionId === sid && t.summary === "再開")).toBe(true);
    expect([...env.api.tasks.values()][0]!.status).toBe("done");
    expect([...env.api.sessions.values()].filter((s) => s.role === "member")).toHaveLength(1);
  }, 40_000);

  it("--resume できなければ新しいセッションに「前任の変更が残っている」", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_CLAUDE_SLOW_MS: "200" } });
    const sid = await crashMidMember(env);
    // 偽 claude のセッションの記録を消す（No conversation found）
    const stateDir = process.env.FAKE_CLAUDE_STATE_DIR!;
    for (const f of await readdir(stateDir, { recursive: true })) if (String(f).includes(sid)) await rm(path.join(stateDir, String(f)), { recursive: true, force: true });
    await env.step();
    expect(env.api.sessions.get(sid)!.status).toBe("failed");
    const fresh = [...env.api.sessions.values()].find((s) => s.role === "member" && s.id !== sid)!;
    expect(fresh.status).toBe("done");
    expect(env.api.transcript.some((t) => t.sessionId === fresh.id && String((t.body as { text?: string }).text ?? "").includes("前任の変更が残っている。git status で確かめて続けて"))).toBe(true);
    expect(existsSync([...env.api.workspaces.values()].find((w) => w.purpose === "integration")!.worktreePath)).toBe(true);
  }, 40_000);
});
