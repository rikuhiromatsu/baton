// R16 並行と衝突（7.4・D-82・シナリオ B2）: 2 人が別々の worktree で並行し、paths が重なって衝突 → merge --abort →
// merge_conflict → リーダーの resolve_conflict → 衝突の印を入れた worktree でメンバーが解決 → 統合済み。本体は変わらない。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { git, makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R16 並行と衝突", () => {
  it("[parallel]: 2 つのタスクが同時に動き、両方が統合される", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_CLAUDE_STEP_MS: "30" } });
    env.api.ceoSays(COO_THREAD_ID, "前後半に分けて書いて [parallel]");
    await env.step();
    await env.step();
    let maxConcurrent = 0;
    const timer = setInterval(() => (maxConcurrent = Math.max(maxConcurrent, env.ctx.coord.memberSessions.size)), 5);
    await env.step();
    clearInterval(timer);
    expect(maxConcurrent).toBe(2);
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(git(integration.worktreePath, "ls-files").split("\n").filter((f) => f.startsWith("part")).length).toBe(2);
  }, 30_000);

  it("[conflict]: 衝突 → resolve_conflict → 解決タスク → 統合済み → リーダーの報告", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "同じファイルに案を書いて [conflict]");
    await env.step(); // COO
    await env.step(); // リーダー plan（t1・t2 が shared/notes.md）
    await env.step(); // メンバー 2 人 → 片方が衝突
    const conflict = env.api.inbox.find((i) => i.kind === "merge_conflict")!;
    expect(conflict.payload.files).toEqual(["shared/notes.md"]);
    expect(env.api.inbox.some((i) => i.kind === "member_results")).toBe(false);
    const conflicted = [...env.api.workspaces.values()].find((w) => w.status === "conflict")!;
    expect(conflicted).toBeTruthy();
    expect(env.api.transcript.some((t) => t.summary.startsWith("衝突"))).toBe(true);
    // 統合用は衝突の途中の状態を残していない（--abort 済み）
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(git(integration.worktreePath, "status", "--porcelain")).toBe("");

    await env.step(); // リーダー resolve_conflict
    const fix = [...env.api.tasks.values()].find((t) => t.title.startsWith("衝突の解決"))!;
    expect(fix.spec.startsWith(`衝突の解決: ${conflicted.branch}`)).toBe(true);
    await env.drain();
    expect(env.api.tasks.get(fix.id)!.status).toBe("done");
    expect(env.api.workspaces.get(conflicted.id)!.status).toBe("merged");
    const notes = await readFile(path.join(integration.worktreePath, "shared/notes.md"), "utf8");
    expect(notes).not.toMatch(/^<{7}/m);
    expect(notes).toContain("A 案");
    expect(notes).toContain("B 案");
    expect([...env.api.instructions.values()][0]!.status).toBe("review");
    // 本体（Baton 専用）の main は確定まで変わらない
    const project = [...env.api.projects.values()][0]!;
    expect(git(path.join(env.dataDir, "projects", project.slug), "log", "--oneline", "main").split("\n")).toHaveLength(1);
  }, 60_000);
});
