// E7 実行中（[slow]）を左フリック → 取消。メンバーが止まる（以降タスク・セッションが増えない）（v1 3.5、DESIGN-v2 5.7）。
// 両スレッドに notice（4.4）
import { COO_THREAD_ID } from "@baton/shared";
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { flick } from "../helpers/swipe.ts";
import { cardInPanel, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E7 処理中の指示を左フリックで取り消すと、メンバーが止まりそれ以上進まない", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E7", testInfo);
  const cooStart = await api.lastSeq(COO_THREAD_ID);
  const created = await api.createInstructionViaChat(marker, "[slow] 取り消す指示");

  await page.goto("/");
  const card = await cardInPanel(page, testInfo, created.id);
  // 待機のままフリックすると expectedStatus が食い違って 409 になりうるので、実行中になったのを見てからフリックする
  await expect(card).toHaveAttribute("data-status", "running", { timeout: RUNNER_TIMEOUT });

  await flick(page, card, "left");
  await expect(card).toHaveAttribute("data-status", "canceled");
  await api.waitForStatus(created.id, "canceled", 10_000);

  // メンバーのセッションが止まる（interrupt → 閉じる → 5 秒で SIGTERM。D-67）
  await api.waitForDetail(
    created.id,
    (d) => d.sessions.filter((s) => s.role === "member").every((s) => !["running", "pending", "awaiting_approval"].includes(s.status)),
    "メンバーのセッションが止まる",
    20_000,
  );
  // 取消のあと、タスクもセッションもトランスクリプトも増えない
  await expectStable(
    async () => {
      const d = await api.detail(created.id);
      return {
        status: d.instruction.status,
        tasks: d.tasks.length,
        sessions: d.sessions.map((s) => `${s.id}:${s.status}:${s.lastSeq}`).sort(),
      };
    },
    6_000,
    "取消のあとにタスクやセッションが増えない",
  );
  await expect(card).toHaveAttribute("data-status", "canceled");

  // COO スレッドとリーダーのスレッドに notice
  await api.waitForMessage(COO_THREAD_ID, { kind: "notice", instructionId: created.id, afterSeq: cooStart, status: null }, 15_000);
  const leader = await api.leaderThread(created.projectId!);
  await api.waitForMessage(leader.id, { kind: "notice", instructionId: created.id, status: null }, 15_000);
});
