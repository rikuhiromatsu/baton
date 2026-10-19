// E51 組織図（DESIGN-v2 13.9・D-57）: ① 指示が動くとリーダー・メンバーのノードの状態がリアルタイムに変わる（再読み込みなし）
// ② CEO がリーダーと話している間はリーダーが `話し中` ③ ノードからの遷移（COO → /、リーダー → /p/:id/leader、メンバー → 詳細）
// ④ エージェントの長押しでシート（職種・スキル・道具。GET /api/profiles と同じ中身）
import { AGENT_STATE_LABELS, MEMBER_PROFILE_LABELS, TESTIDS, UI_TEXT_V2, type MemberProfile } from "@baton/shared";
import { MARK as M, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { longPress } from "../helpers/swipe.ts";
import { byTestId, onlyOn, orgNode, press, revealOrgNode, uniqueMarker } from "../helpers/ui.ts";


test("E51 組織図はリアルタイムに状態が変わり、ノードから会話・作業へ移れる", async ({ page, context, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop, PROJECTS.iphoneChromium]);
  test.setTimeout(300_000);
  const marker = uniqueMarker("E51", testInfo);

  // 組織図を開いたまま、ノードの data-state の移り変わりをすべて記録する（あとから現れるプロジェクトのノードも）
  await page.goto("/org");
  await expect(byTestId(page, TESTIDS.orgChart)).toBeVisible();
  await expect(page.locator(`[data-testid="${TESTIDS.orgNode}"][data-role="coo"]`)).toBeVisible();
  await page.evaluate((testid) => {
    const w = window as unknown as { __batonOrgLog?: Record<string, string[]> };
    const log = (w.__batonOrgLog = {} as Record<string, string[]>);
    const record = () => {
      for (const el of Array.from(document.querySelectorAll(`[data-testid="${testid}"]`))) {
        const id = el.getAttribute("data-agent-id");
        const s = el.getAttribute("data-state");
        if (!id || !s) continue;
        const arr = (log[id] ??= []);
        if (arr[arr.length - 1] !== s) arr.push(s);
      }
    };
    record();
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-agent-id"] });
  }, TESTIDS.orgNode);

  // ① 指示が動く（偽 COO は依頼ごとに Baton 専用のプロジェクトを立てる）→ 再読み込みなしで新しいプロジェクトのノードが現れ、
  //    リーダー・メンバーが実行中になり、終わると手すき・待機に戻る
  const created = await api.createInstructionViaChat(marker, `${M.slow} 組織図を動かす`);
  const projectId = created.projectId!;
  let team = (await api.org()).projects.find((p) => p.project.id === projectId);
  await expect.poll(async () => {
    team = (await api.org()).projects.find((p) => p.project.id === projectId);
    return team?.members.length ?? 0;
  }, { message: "組織図にチームが出る" }).toBeGreaterThan(0);
  const projectName = team!.project.name;
  const leaderId = team!.leader!.agent.id;
  const memberIds = team!.members.map((m) => m.agent.id);
  const node = (agentId: string) => orgNode(page, agentId);
  const reveal = (agentId: string) => revealOrgNode(page, testInfo, agentId, projectName);
  // モバイルは折りたたみなので、メンバーが動き出す前に開いておく（[slow] で COO・リーダーの番に時間がある）
  await reveal(leaderId);
  for (const id of memberIds) await reveal(id);
  await api.waitForStatus(created.id, "review", RUNNER_TIMEOUT);
  const seen = await page.evaluate(() => (window as unknown as { __batonOrgLog?: Record<string, string[]> }).__batonOrgLog ?? {});
  const memberStates = memberIds.flatMap((id) => seen[id] ?? []);
  expect(memberStates, `メンバーの状態の移り変わり: ${JSON.stringify(seen)}`).toContain("running");
  expect(seen[leaderId] ?? [], "リーダーも動く").toContain("running");
  for (const id of memberIds) await expect(node(id)).toHaveAttribute("data-state", /^(idle|queued)$/);
  await expect(node(memberIds[0]!)).toContainText(new RegExp(`${AGENT_STATE_LABELS.idle}|${AGENT_STATE_LABELS.queued}`));

  // ② CEO がリーダーと話している間は `話し中`（別のタブで組織図を見る）
  const watcher = await context.newPage();
  await watcher.goto("/org");
  await revealOrgNode(watcher, testInfo, leaderId, projectName);
  const leader = await api.leaderThread(projectId);
  await watcher.evaluate(
    ({ testid, id }) => {
      const w = window as unknown as { __batonTalking?: boolean };
      w.__batonTalking = false;
      const check = () => {
        if (document.querySelector(`[data-testid="${testid}"][data-agent-id="${id}"][data-state="talking"]`)) w.__batonTalking = true;
      };
      check();
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    },
    { testid: TESTIDS.orgNode, id: leaderId },
  );
  await api.postMessage(leader.id, `${M.slow} ${marker} 進み具合はどう？`);
  await expect
    .poll(() => watcher.evaluate(() => (window as unknown as { __batonTalking?: boolean }).__batonTalking === true), {
      message: "リーダーが話し中になる",
      timeout: RUNNER_TIMEOUT,
    })
    .toBe(true);
  await api.leaveThread(leader.id);
  await watcher.close();

  // ③ ノードからの遷移
  await press(page.locator(`[data-testid="${TESTIDS.orgNode}"][data-role="coo"]`), testInfo);
  await expect(page).toHaveURL(/\/(?:[?#]|$)/);
  await page.goto("/org");
  await press(await reveal(leaderId), testInfo);
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}/leader(?:[?#]|$)`));
  await page.goto("/org");
  await press(await reveal(memberIds[0]!), testInfo);
  // メンバーはそのセッションの詳細（複数ならポップオーバーから選ぶ）
  if (!/\/i\//.test(page.url())) {
    await page.locator(`a[href*="/i/"]`).first().click();
  }
  await expect(page).toHaveURL(/\/i\/[^/?#]+/);

  // ④ 長押しでエージェントのシート（職種・スキル・道具）
  await page.goto("/org");
  const memberAgent = team!.members[0]!.agent;
  await longPress(page, await reveal(memberAgent.id));
  const sheet = byTestId(page, TESTIDS.agentSheet);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(UI_TEXT_V2.org.profile);
  await expect(sheet).toContainText(UI_TEXT_V2.org.skills);
  await expect(sheet).toContainText(UI_TEXT_V2.org.tools);
  const profileId = memberAgent.profile ?? "generalist";
  if (profileId in MEMBER_PROFILE_LABELS) await expect(sheet).toContainText(MEMBER_PROFILE_LABELS[profileId as MemberProfile]);
  const profile = (await api.profiles()).find((p) => p.id === profileId);
  expect(profile, `プロファイル ${profileId} が GET /api/profiles にある`).toBeTruthy();
  for (const skill of profile!.skills) await expect(sheet).toContainText(skill);
  for (const tool of profile!.tools.slice(0, 3)) await expect(sheet).toContainText(tool);
});
