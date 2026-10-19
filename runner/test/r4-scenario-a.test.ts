// R4 シナリオ A 全体（14.1 の A1〜A9）: 偽 claude と偽 Worker で、COO → リーダー → メンバー → 統合 → 報告 → 降りていく → 確定。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { git, makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R4 シナリオ A", () => {
  it("A1〜A9: 質問 → 依頼 → 並行の worktree → 報告 → リーダーと話す（rev 2・leader_report）→ 相づち → 報告 → 承認で main へ", async () => {
    env = await makeEnv();
    const { api } = env;

    // A1: 質問を返す。指示もプロジェクトもできない
    api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    await env.drain();
    expect(api.agentMessages(COO_THREAD_ID).map((m) => m.body)).toEqual(["なんの動画ですか？"]);
    expect(api.instructions.size).toBe(0);
    expect(api.projects.size).toBe(0);
    expect(api.threads.get(COO_THREAD_ID)!.awaitingReply).toBe(true);
    // ストリーミングで本文が届いている
    expect(api.streams.filter((s) => s.threadId === COO_THREAD_ID).map((s) => s.delta).join("")).toContain("なんの動画ですか？");

    // A2〜A3: 依頼 → プロジェクトが立つ → リーダーの plan → メンバー 2 人が別々の worktree → 統合 → リーダーの report → COO の present
    api.ceoSays(COO_THREAD_ID, "コーヒー紹介のやつです。題材は提案して。");
    const ran = await env.drain();
    expect(ran.some((r) => r.kind === "instruction")).toBe(true);
    const project = [...api.projects.values()][0]!;
    expect(project.slug).toBe("shorts");
    const instr = [...api.instructions.values()][0]!;
    expect(instr.status).toBe("review");
    const cooBodies = api.agentMessages(COO_THREAD_ID).map((m) => m.body);
    expect(cooBodies).toContain("わかりました、ではチームリーダーに依頼します。");
    expect(cooBodies.some((b) => b.startsWith("チームリーダーから 10 本の案が上がって来ました。"))).toBe(true);
    const report = api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "report")!;
    expect(report.instructionId).toBe(instr.id);
    // 依頼で動いたリーダーの発言は通知しない（未読を増やさない）
    const leaderThread = `thread-${project.id}`;
    expect(api.agentMessages(leaderThread).filter((m) => m.authorKind === "leader").every((m) => m.notify === false)).toBe(true);
    // タスクごとの worktree とブランチ（t1-r1・t2-r1）、統合用へマージ
    const ws = [...api.workspaces.values()];
    const short = instr.id.replace(/-/g, "").slice(0, 8);
    expect(ws.filter((w) => w.purpose === "task").map((w) => w.branch).sort()).toEqual([`baton/${short}/t1-r1`, `baton/${short}/t2-r1`]);
    expect(ws.filter((w) => w.purpose === "task").every((w) => w.status === "merged")).toBe(true);
    const integration = ws.find((w) => w.purpose === "integration")!;
    expect(existsSync(path.join(integration.worktreePath, "research/notes.md"))).toBe(true);
    expect(existsSync(path.join(integration.worktreePath, "scripts/scripts.md"))).toBe(true);
    expect(integration.diffStat.map((d) => d.path).sort()).toEqual(["research/notes.md", "scripts/scripts.md"]);
    // 本体（Baton 専用）の main はまだ変わらない
    const body = path.join(env.dataDir, "projects/shorts");
    expect(git(body, "log", "--oneline", "main")).not.toContain("台本");
    // メンバーのセッションは「--include-partial-messages」を付けない・スレッドは付ける（トランスクリプトの system が残る）
    expect(api.transcript.some((t) => t.kind === "system" && t.summary === "開始")).toBe(true);
    expect(api.transcript.some((t) => t.summary.startsWith("統合"))).toBe(true);

    // A4〜A5: リーダーに降りて方針変更 → その場で返事・plan（ラウンド 2）・leader_report・rev 2
    const sessionsBefore = api.sessions.size;
    api.ceoSays(leaderThread, "方向性がちょっと違うかも。もっとニッチなやつがいい", { instructionId: instr.id });
    await env.step();
    expect(api.agentMessages(leaderThread).at(-1)!.body).toBe("わかりました。リサーチメンバーに参考を集めさせます");
    expect(api.instr(instr.id).revision).toBe(2);
    expect(api.instr(instr.id).status).toBe("running");
    const lr = api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "leader_report")!;
    expect(lr.authorKind).toBe("leader");
    // COO のターンは起きない（wakes=0）
    expect(api.pendingInbox(COO_THREAD_ID).filter((i) => i.kind === "leader_report").every((i) => !i.wakes)).toBe(true);

    // A6: 相づち → 何も増えない
    const tasksBefore = api.tasks.size;
    const ack = api.ceoSays(leaderThread, "たすかる！");
    // A5 で増えたタスクを先に流さず、相づちだけを処理する
    const r6 = await env.step();
    expect(r6?.kind).toBe("thread");
    expect(api.messagesOf(leaderThread).find((m) => m.id === ack.id)!.reaction).toBe("ack");
    expect(api.tasks.size).toBe(tasksBefore);

    // A7〜A8: ラウンド 2 が回り、COO が A5 を踏まえて報告
    await env.drain();
    expect(api.sessions.size).toBeGreaterThan(sessionsBefore);
    const last = api.agentMessages(COO_THREAD_ID).filter((m) => m.kind === "report").at(-1)!;
    expect(last.body.startsWith("ニッチ寄りに組み直した 10 本です。")).toBe(true);
    expect(api.instr(instr.id).status).toBe("review");
    expect([...api.workspaces.values()].some((w) => w.branch === `baton/${short}/t3-r2`)).toBe(true);

    // A9: 承認 → 確定（main へ --no-ff、worktree とブランチを消す）
    api.approve(instr.id);
    const fin = await env.drain();
    expect(fin.map((r) => r.kind)).toContain("finalize");
    expect(api.finalizedLog[0]!.input.outcome).toBe("merged");
    expect(await readFile(path.join(body, "research/niche.md"), "utf8")).toContain("ニッチ");
    expect(git(body, "branch", "--list", "baton/*")).toBe("");
    expect(existsSync(integration.worktreePath)).toBe(false);
    const finalWs = [...api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(finalWs.status).toBe("merged");
    expect(finalWs.finalizedAt).not.toBeNull();
  }, 60_000);
});
