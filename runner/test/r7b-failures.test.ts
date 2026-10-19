// R7（続き）失敗と取消の道（Codex の指摘から）: result 無しで終わる claude を無限に起動しない、
// 承認待ちの途中の取消はすぐ止まる、失敗した依存の先のタスクは失敗にしてリーダーへ結果を渡す。
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { StopSignal } from "../src/errors.ts";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R7 失敗と取消の道", () => {
  it("result を出さずに終わる claude は、やり直しの回数だけ起動して失敗にする", async () => {
    env = await makeEnv();
    const count = path.join(env.dir, "count.txt");
    const bin = path.join(env.dir, "broken-claude.sh");
    await writeFile(bin, `#!/bin/sh\necho x >> "${count}"\nexit 2\n`);
    await chmod(bin, 0o755);
    (env.config as { claudeBin: string }).claudeBin = bin;
    env.api.ceoSays(COO_THREAD_ID, "こんにちは");
    const r = await env.step();
    expect(r?.outcome).toBe("failed");
    // 最初の起動 ＋ やり直し 1 回（新しいセッション）だけ
    expect((await readFile(count, "utf8")).trim().split("\n").length).toBeLessThanOrEqual(1 + env.config.limits.turnRetries + 1);
    expect(env.api.agentMessages(COO_THREAD_ID).at(-1)!.body).toBe("うまく返事ができませんでした");
  }, 30_000);

  it("承認待ちの途中で取消したら、承認の時間切れを待たずに止まる", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "承認の確認 [approve]");
    await env.step();
    await env.step();
    const ac = new AbortController();
    const run = env.step(ac.signal);
    await waitFor(() => [...env.api.decisions.values()].some((d) => d.kind === "approval"));
    const started = Date.now();
    ac.abort(new StopSignal("cancel"));
    await run;
    expect(Date.now() - started).toBeLessThan(8000);
    expect([...env.api.sessions.values()].find((s) => s.role === "member")!.status).toBe("canceled");
    expect([...env.api.decisions.values()].some((d) => d.kind === "interrupted")).toBe(false);
  }, 30_000);

  it("依存するタスクが失敗したら、その先のタスクも失敗にしてリーダーに結果を渡す", async () => {
    env = await makeEnv();
    const p = env.api.addProject({ slug: "dep", name: "依存" });
    const instr = await env.api.createInstruction({ id: randomUUID(), title: "依存", body: "依存の確認", projectId: p.id, originThreadId: `thread-${p.id}`, originMessageId: null, phase: "members" });
    await env.api.createTasks({
      tasks: [
        { instructionId: instr.id, parentTaskId: null, assigneeAgentId: `${p.id}-m0`, kind: "work", planKey: "t1", dependsOn: [], title: "前段", spec: "前段 [giveup@member]", paths: [], round: 1, seq: 0 },
        { instructionId: instr.id, parentTaskId: null, assigneeAgentId: `${p.id}-m0`, kind: "work", planKey: "t2", dependsOn: ["t1"], title: "後段", spec: "後段", paths: [], round: 1, seq: 1 },
      ],
    });
    const r = await env.step();
    expect(r?.kind).toBe("instruction");
    const tasks = [...env.api.tasks.values()];
    expect(tasks.find((t) => t.planKey === "t1")!.status).toBe("failed");
    expect(tasks.find((t) => t.planKey === "t2")!.resultSummary).toContain("依存するタスク（t1）が失敗");
    const results = env.api.inbox.find((i) => i.kind === "member_results")!;
    expect(JSON.stringify(results.payload)).toContain("t2");
    expect([...env.api.sessions.values()].filter((s) => s.role === "member")).toHaveLength(1);
  }, 30_000);
});
