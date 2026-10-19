// E40 シナリオ A（DESIGN-v2 14.1 の A1〜A9）を 1 本で通す。偽 claude の台本は [scenario-a]（15.2）。
// COO に依頼 → COO の質問 → 回答 → リーダーに依頼 → 案が届く → リーダーに降りて方向修正 → リーダーが COO に報告 →
// 気軽な返事で余計な処理が走らない → COO に戻る → 組み直した案 → 承認して確定。
// 同じサーバーで desktop と iphone-webkit が続けて走るので、発言は「このテストが始まった時点の seq より後」だけを見る。
import fs from "node:fs";
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2, type InstructionDetail, type InstructionSummary } from "@baton/shared";
import { FINALIZE_DELAY_MS, MARK, PROJECTS, RUNNER_TIMEOUT, SCENARIO_A, SCENARIO_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { branches } from "../helpers/git.ts";
import { batonProjectDir } from "../helpers/runner.ts";
import { flick } from "../helpers/swipe.ts";
import {
  byTestId,
  cardInPanel,
  closeCardsPanel,
  expectMessageOnScreen,
  expectStable,
  messageBySeq,
  onlyOn,
  press,
  sendFromComposer,
  trackedStatuses,
  trackStatuses,
} from "../helpers/ui.ts";

const say = (text: string) => `${MARK.scenarioA} ${text}`;
const memberSessions = (d: InstructionDetail) => d.sessions.filter((s) => s.role === "member");

test("E40 シナリオ A: COO との会話から立ち、リーダーに降りて方向修正し、承認で確定する", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop, PROJECTS.iphoneWebkit]);
  test.setTimeout(480_000);

  const cooStart = await api.lastSeq(COO_THREAD_ID);
  const before = new Set((await api.list()).map((i) => i.id));
  const newInstructions = async (): Promise<InstructionSummary[]> => (await api.list()).filter((i) => !before.has(i.id));

  await page.goto("/");
  await expect(byTestId(page, TESTIDS.thread).first()).toHaveAttribute("data-kind", "coo");
  // 入力中の印（3 点の呼吸か、ストリーミング中の吹き出し）が一度でも出たかをページの中で記録する
  await page.evaluate(
    ({ typing, message }) => {
      const w = window as unknown as { __batonTypingSeen?: boolean };
      w.__batonTypingSeen = false;
      const check = () => {
        if (document.querySelector(`[data-testid="${typing}"], [data-testid="${message}"][data-status="streaming"]`)) w.__batonTypingSeen = true;
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-status"] });
    },
    { typing: TESTIDS.messageTyping, message: TESTIDS.message },
  );

  // ───── A1: 依頼 → COO が質問を返す。カードもプロジェクトもできない ─────
  await test.step("A1 COO が質問を返し、返事待ちになる", async () => {
    await sendFromComposer(page, say(SCENARIO_A.ceo1), testInfo);
    await expectMessageOnScreen(page, { author: "ceo", text: SCENARIO_A.ceo1, afterSeq: cooStart, status: null });
    await expectMessageOnScreen(page, { author: "coo", text: SCENARIO_A.coo1, afterSeq: cooStart });
    expect(await page.evaluate(() => (window as unknown as { __batonTypingSeen?: boolean }).__batonTypingSeen), "COO の入力中の印が出た").toBe(true);
    await expect(byTestId(page, TESTIDS.awaitingReply)).toBeVisible();
    // 質問だけで、指示もプロジェクト案もできない（少し待っても増えない）
    await expectStable(async () => (await newInstructions()).length, 2_000, "A1 では指示ができない");
    expect(await api.findMessages(COO_THREAD_ID, { kind: "project_proposal", afterSeq: cooStart, status: null })).toHaveLength(0);
    const coo = await api.cooThread();
    expect(coo.awaitingReply).toBe(true);
  });

  // ───── A2: 回答 → COO がリーダーに依頼。プロジェクト（Baton 専用）が立ち、指示カードができる ─────
  let instruction!: InstructionSummary;
  let projectId!: string;
  let leaderThreadId!: string;
  await test.step("A2 回答するとプロジェクトが立ち、リーダーに依頼が渡る", async () => {
    await sendFromComposer(page, say(SCENARIO_A.ceo2), testInfo);
    await expectMessageOnScreen(page, { author: "coo", text: SCENARIO_A.coo2, afterSeq: cooStart });
    await expect.poll(async () => (await newInstructions()).length, { message: "指示が 1 つできる", timeout: RUNNER_TIMEOUT }).toBe(1);
    instruction = (await newInstructions())[0]!;
    expect(instruction.projectName ?? "").toContain(SCENARIO_A.projectName);
    projectId = instruction.projectId!;
    const project = await api.project(projectId);
    expect(project.workspaceKind).toBe("baton");
    expect(project.agents.filter((a) => a.role === "member").map((a) => a.profile).sort()).toEqual(["researcher", "writer"]);

    // COO スレッドに「指示ができた」（delegation）のカード
    const delegation = await api.waitForMessage(COO_THREAD_ID, { kind: "delegation", instructionId: instruction.id, afterSeq: cooStart });
    await expect(messageBySeq(page, delegation.seq).locator(`[data-testid="${TESTIDS.messageInstructionCard}"]`)).toBeVisible();
    await expect(byTestId(page, TESTIDS.awaitingReply)).toBeHidden();

    // 指示カードが 待機 → 実行中
    const card = await cardInPanel(page, testInfo, instruction.id);
    await expect(card).toBeVisible();
    await trackStatuses(page, instruction.id);

    // リーダーのスレッドに COO の依頼とリーダーの返事。ただし未読は増えない（COO からの依頼で動いたので。4.8）
    leaderThreadId = (await api.leaderThread(projectId)).id;
    await api.waitForMessage(leaderThreadId, { authorKind: "coo", instructionId: instruction.id });
    await api.waitForMessage(leaderThreadId, { authorKind: "leader", text: SCENARIO_A.leader1 });
    expect((await api.thread(leaderThreadId)).unread, "リーダーのスレッドの未読は増えない").toBe(0);
  });

  // ───── A3: メンバー 2 人が別々の worktree で作業 → COO が案を報告。カードが確認 ─────
  let reportSeq = -1;
  await test.step("A3 メンバーが別々の worktree で作業し、COO から 10 本の案が届く", async () => {
    reportSeq = await expectMessageOnScreen(page, { author: "coo", kind: "report", text: SCENARIO_A.coo3, afterSeq: cooStart }, SCENARIO_TIMEOUT);
    const card = await cardInPanel(page, testInfo, instruction.id);
    await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
    const seen = await trackedStatuses(page, instruction.id);
    expect(seen, `状態の移り変わり: ${seen.join(" → ")}`).toContain("running");

    const d = await api.waitForStatus(instruction.id, "review");
    const id8 = instruction.id.slice(0, 8);
    const taskBranches = d.workspaces.filter((w) => w.purpose === "task").map((w) => w.branch).sort();
    expect(taskBranches).toEqual([`baton/${id8}/t1-r1`, `baton/${id8}/t2-r1`]);
    expect(new Set(d.workspaces.filter((w) => w.purpose === "task").map((w) => w.worktreePath)).size, "worktree は別々").toBe(2);
    expect(d.workspaces.find((w) => w.purpose === "integration")?.branch).toBe(`baton/${id8}/integration`);
    expect(memberSessions(d)).toHaveLength(2);
  });

  // ───── A4: COO の発言のカードから「リーダーと話す」 ─────
  await test.step("A4 発言のカードの「リーダーと話す」でリーダーのスレッドへ降りる", async () => {
    // A3 でモバイルはカードのシートを開いたままなので閉じてから（シートが会話を覆っている）
    await closeCardsPanel(page, testInfo);
    const report = messageBySeq(page, reportSeq);
    await report.scrollIntoViewIfNeeded();
    await press(report.locator(`[data-testid="${TESTIDS.leaderLink}"]`).first(), testInfo);
    await expect(page).toHaveURL(new RegExp(`/p/${projectId}/leader(?:[?#]|$)`));
    await expect(byTestId(page, TESTIDS.backToCoo)).toBeVisible();
    await expect(page.getByText(UI_TEXT_V2.conversation.reportedToCoo)).toBeVisible();
    await expect(byTestId(page, TESTIDS.thread).first()).toHaveAttribute("data-kind", "leader");
    await expect(byTestId(page, TESTIDS.threadTarget)).toContainText(UI_TEXT_V2.roles.leader);
  });

  // ───── A5: リーダーに方向修正 → リーダーがその場で返事し、リサーチを再び動かし、COO に報告する ─────
  const leaderStart = await api.lastSeq(leaderThreadId);
  await test.step("A5 リーダーが返事し、指示が rev 2 で再開し、COO スレッドに報告が残る", async () => {
    await sendFromComposer(page, say(SCENARIO_A.ceo3), testInfo);
    await expectMessageOnScreen(page, { author: "leader", text: SCENARIO_A.leader2, afterSeq: leaderStart });

    const d = await api.waitForDetail(
      instruction.id,
      (d) => d.instruction.revision === 2 && d.tasks.some((t) => t.planKey === "t3"),
      "rev 2 と t3（リサーチ）のタスクができる",
    );
    // 確認（review）→ 実行中（reopen）。rev 2 と新しいタスクができたことが reopen の証拠（リーダーのスレッドにはカードの列が無いことがあるので API で見る）
    expect(["running", "review", "queued"]).toContain(d.instruction.status);

    const report = await api.waitForMessage(COO_THREAD_ID, { kind: "leader_report", authorKind: "leader", instructionId: instruction.id, afterSeq: cooStart });
    expect(report.notify, "leader_report は通知しない").toBe(false);

    // t3 のメンバーのセッションが新しい worktree（ラウンド 2）で起動する
    const d2 = await api.waitForDetail(instruction.id, (d) => d.workspaces.some((w) => w.branch.endsWith("/t3-r2")), "t3-r2 の worktree");
    await api.waitForDetail(instruction.id, (x) => memberSessions(x).length === 3, "t3 のメンバーのセッション");
    expect(d2.tasks.find((t) => t.planKey === "t3")?.round).toBe(2);
  });

  // ───── A6: 相づち → リーダーは何も書かない。タスク・セッション・指示・報告は増えない ─────
  await test.step("A6 「たすかる！」には既読だけが付き、何も増えない", async () => {
    // リーダーが t3 の結果をまとめて COO に渡し終えてから（同じターンに相づちが混ざらないように）
    await api.waitForDetail(instruction.id, (d) => d.instruction.phase === "coo" || d.instruction.status === "review", "リーダーが t3 の結果をまとめる", SCENARIO_TIMEOUT);
    const snapshot = async () => {
      const d = await api.detail(instruction.id);
      const leaderMsgs = await api.findMessages(leaderThreadId, { authorKind: "leader", status: null });
      const reports = await api.findMessages(COO_THREAD_ID, { kind: "leader_report", instructionId: instruction.id, status: null });
      return {
        tasks: d.tasks.length,
        memberSessions: memberSessions(d).length,
        instructions: (await newInstructions()).length,
        revision: d.instruction.revision,
        leaderMessages: leaderMsgs.length,
        leaderReports: reports.length,
      };
    };
    const beforeAck = await snapshot();
    const ackStart = await api.lastSeq(leaderThreadId);
    await sendFromComposer(page, say(SCENARIO_A.ceo4), testInfo);
    const ceo4 = await api.waitForMessage(leaderThreadId, { authorKind: "ceo", text: SCENARIO_A.ceo4, afterSeq: ackStart });
    await expect.poll(async () => (await api.findMessages(leaderThreadId, { authorKind: "ceo", text: SCENARIO_A.ceo4, afterSeq: ackStart }))[0]?.reaction, {
      message: "相づちに ack が付く",
      timeout: RUNNER_TIMEOUT,
    }).toBe("ack");
    await expect(messageBySeq(page, ceo4.seq).locator(`[data-testid="${TESTIDS.messageAck}"]`)).toBeVisible();
    expect(await snapshot()).toEqual(beforeAck);
    await expectStable(snapshot, 3_000, "相づちのあと、タスク・セッション・指示・報告・リーダーの発言が増えない");
    // 組織図（/org）の数も同じ: このプロジェクトのメンバーの仕事の数
    const org = await api.org();
    const proj = org.projects.find((p) => p.project.id === projectId);
    expect(proj, "組織図にプロジェクトがある").toBeTruthy();
  });

  // ───── A7: COO に戻る → A5 の報告が見える ─────
  await test.step("A7 COO に戻ると、リーダーからの報告が見える", async () => {
    await press(byTestId(page, TESTIDS.backToCoo), testInfo);
    await expect(page).toHaveURL(/\/(?:[?#]|$)/);
    await expect(byTestId(page, TESTIDS.thread).first()).toHaveAttribute("data-kind", "coo");
    // モバイルはリーダーのスレッドが右へ抜けるまで DOM に残り、同じ seq の発言が 2 つ見える。抜け終わるのを待つ
    await expect(byTestId(page, TESTIDS.thread)).toHaveCount(1);
    const leaderReportSeq = await expectMessageOnScreen(page, { author: "leader", kind: "leader_report", afterSeq: cooStart });
    await expect(messageBySeq(page, leaderReportSeq)).toContainText(UI_TEXT_V2.conversation.toCoo);
  });

  // ───── A8: COO が組み直した案を報告（A5 を踏まえる）。カードが確認 ─────
  await test.step("A8 COO からニッチ寄りの案が届き、カードが確認になる", async () => {
    const finalSeq = await expectMessageOnScreen(page, { author: "coo", kind: "report", text: SCENARIO_A.coo4, afterSeq: cooStart }, SCENARIO_TIMEOUT);
    // leader_report は COO のターンを起こさない: 報告から最後の案までの間に COO の発言は無い
    const msgs = await api.messages(COO_THREAD_ID);
    const lr = msgs.find((m) => m.kind === "leader_report" && m.instructionId === instruction.id && m.seq > cooStart)!;
    const between = msgs.filter((m) => m.seq > lr.seq && m.seq < finalSeq && m.authorKind === "coo");
    expect(between.map((m) => m.body.slice(0, 30)), "leader_report で COO のターンが起きない").toEqual([]);
    const card = await cardInPanel(page, testInfo, instruction.id);
    await expect(card).toHaveAttribute("data-status", "review", { timeout: RUNNER_TIMEOUT });
    const d = await api.detail(instruction.id);
    expect(d.instruction.revision).toBe(2);
  });

  // ───── A9: 右フリックで承認 → 20 秒後に main へマージ、worktree が消える ─────
  await test.step("A9 右フリックで承認し、確定で main に取り込まれ worktree が消える", async () => {
    const card = await cardInPanel(page, testInfo, instruction.id);
    await flick(page, card, "right");
    await expect(card).toHaveAttribute("data-status", "done");
    await api.waitForStatus(instruction.id, "done", 15_000);
    const d = await api.waitForDetail(
      instruction.id,
      (d) => d.instruction.finalizedAt !== null && d.workspaces.find((w) => w.purpose === "integration")?.status === "merged",
      "確定（統合用が main にマージされる）",
      FINALIZE_DELAY_MS + 60_000,
    );
    const project = await api.project(projectId);
    const repo = batonProjectDir(project.slug);
    expect(branches(repo, `baton/${instruction.id.slice(0, 8)}/*`), "baton/<id8>/* のブランチが消える").toEqual([]);
    for (const w of d.workspaces) {
      await expect.poll(async () => fs.existsSync(w.worktreePath), { message: `${w.worktreePath} が消える` }).toBe(false);
    }
  });
});
