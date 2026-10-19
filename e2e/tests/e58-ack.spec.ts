// E58 相づちで何も増えない（DESIGN-v2 4.5・4.7・D-77）: COO にもリーダーにも「たすかる！」と言うと、返事も行動も無く、
// CEO の発言に `既読`（reaction=ack）だけが付く。指示・タスク・セッション・プロジェクト案・報告は増えない。
// 台本: [scenario-a] の「たすかる」（COO もリーダーも何も書かず、行動なし。15.2）
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT, SCENARIO_A } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { expectStable, messageBySeq, onlyOn, sendFromComposer, uniqueMarker } from "../helpers/ui.ts";
import type { BatonApi } from "../helpers/api.ts";

async function counts(api: BatonApi, threadIds: string[]) {
  const instructions = await api.list();
  const details = await Promise.all(instructions.slice(0, 10).map((i) => api.detail(i.id)));
  const nonCeo = await Promise.all(threadIds.map(async (t) => (await api.messages(t)).filter((m) => m.authorKind !== "ceo").length));
  return {
    instructions: instructions.length,
    tasks: details.reduce((n, d) => n + d.tasks.length, 0),
    sessions: details.reduce((n, d) => n + d.sessions.length, 0),
    projects: (await api.projects()).length,
    nonCeoMessages: nonCeo,
  };
}

/**
 * ほかのテストが残したターン（会話の区切りで動くリーダーの報告と、それを受けた COO のターンなど）が落ち着くまで待ってから数える。
 * 入力中の空の発言は作られてから消えるので、動いている途中に数えると前後で数が合わない
 */
async function quietCounts(api: BatonApi, threadIds: string[]) {
  let last: unknown = null;
  for (let i = 0; i < 12; i++) {
    const busy = (await api.threads()).some((t) => t.status !== "idle");
    const now = await counts(api, threadIds);
    if (!busy && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = busy ? null : now;
    // 会話の区切り（E2E は 3 秒）より長く見る
    await new Promise((r) => setTimeout(r, 3_500));
  }
  throw new Error("スレッドが落ち着かない");
}

test("E58 相づちには既読だけが付き、COO でもリーダーでも何も増えない", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E58", testInfo);
  // 静かな状態を作る: リーダーのスレッドを持つプロジェクトを用意し、全部終わるのを待つ
  const { instruction } = await api.createAndWait(marker, "相づちの準備");
  const leader = await api.leaderThread(instruction.projectId!);
  const threads = [COO_THREAD_ID, leader.id];
  await expect.poll(async () => (await api.cooThread()).status, { timeout: RUNNER_TIMEOUT }).toBe("idle");

  for (const [path, threadId] of [["/", COO_THREAD_ID], [`/p/${instruction.projectId}/leader`, leader.id]] as const) {
    await page.goto(path);
    const before = await quietCounts(api, threads);
    const start = await api.lastSeq(threadId);
    await sendFromComposer(page, `${MARK.scenarioA} ${SCENARIO_A.ceo4}`, testInfo);
    const sent = await api.waitForMessage(threadId, { authorKind: "ceo", text: SCENARIO_A.ceo4, afterSeq: start, status: null }, 15_000);
    await expect
      .poll(async () => (await api.messages(threadId)).find((m) => m.id === sent.id)?.reaction, { message: `${path}: ack が付く`, timeout: RUNNER_TIMEOUT })
      .toBe("ack");
    await expect(messageBySeq(page, sent.seq).locator(`[data-testid="${TESTIDS.messageAck}"]`)).toBeVisible();
    // 返事の吹き出し（入力中の空の発言を含む）が残らない
    expect((await api.messages(threadId)).filter((m) => m.seq > sent.seq)).toEqual([]);
    expect(await counts(api, threads)).toEqual(before);
    await expectStable(() => counts(api, threads), 3_000, `${path}: 相づちのあと何も増えない`);
  }
});
