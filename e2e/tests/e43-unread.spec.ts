// E43 既読・未読（DESIGN-v2 4.8）: 別の画面にいる間に COO の発言（notify=1）が完成 → サイドパネルの COO に未読数とトースト →
// COO の会話を開くと 0。リーダーのスレッドは COO からの依頼で動いただけでは未読にならない
import { COO_THREAD_ID, TESTIDS } from "@baton/shared";
import { PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, onlyOn, press, uniqueMarker } from "../helpers/ui.ts";

test("E43 よそを見ている間の COO の発言は未読とトーストになり、開くと既読になる", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E43", testInfo);
  // まず COO スレッドを既読にしておく
  await api.markRead(COO_THREAD_ID, await api.lastSeq(COO_THREAD_ID));
  const start = await api.lastSeq(COO_THREAD_ID);

  // 組織図を見ている間に、別の端末（API）から COO に話しかける
  await page.goto("/org");
  await expect(byTestId(page, TESTIDS.orgChart)).toBeVisible();
  await api.sayToCoo(`${marker} 未読の確認`);
  const reply = await api.waitForMessage(COO_THREAD_ID, { authorKind: "coo", afterSeq: start }, RUNNER_TIMEOUT);
  expect(reply.notify, "COO の返事は notify=1").toBe(true);

  // サイドパネルの COO に未読数、上部にトースト
  const coo = byTestId(page, TESTIDS.sidebarCoo);
  await expect(byTestId(coo, TESTIDS.sidebarUnread)).toBeVisible();
  await expect(byTestId(coo, TESTIDS.sidebarUnread)).toHaveText(/^[1-9]\d*$/);
  await expect(byTestId(page, TESTIDS.toastMessage)).toBeVisible();
  await expect(page).toHaveTitle(/^\(\d+\) Baton$/);
  expect((await api.cooThread()).unread).toBeGreaterThan(0);

  // トーストをタップ → COO の会話 → 既読（1 秒にまとめて送る）
  await press(byTestId(page, TESTIDS.toastMessage).first(), testInfo);
  await expect(page).toHaveURL(/\/(?:[?#]|$)/);
  await expect.poll(async () => (await api.cooThread()).unread, { message: "開くと未読が 0", timeout: 10_000 }).toBe(0);
  await expect(byTestId(coo, TESTIDS.sidebarUnread)).toBeHidden();
  // （タイトルの未読数は他のスレッドの未読も数えるので、ここでは COO の行だけを見る）

  // リーダーのスレッドは COO からの依頼で動いただけでは未読にならない
  const created = await api.findByMarker(marker);
  const leader = await api.leaderThread(created.projectId!);
  await api.waitForMessage(leader.id, { authorKind: "leader", instructionId: created.id }).catch(async () => {
    await api.waitForMessage(leader.id, { authorKind: "leader" });
  });
  expect((await api.thread(leader.id)).unread).toBe(0);
});
