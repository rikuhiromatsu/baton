// E52 立てる（既存リポジトリ）＝シナリオ B3（DESIGN-v2 3.2・7.3〜7.5・14.2、D-50・D-51）:
// COO の propose_project（[propose] [repo]）→ プロジェクト案のカードで `既存リポジトリ` の sample-repo を選んで `立てる` →
// 最初の仕事 → 承認 → 確定。本体の HEAD・チェックアウト中のブランチ・作業ツリー・index・remote が変わらず、
// baton/<id8>/integration が残る（取り込まない・push しない）
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { FINALIZE_DELAY_MS, MARK, PROJECTS, RUNNER_TIMEOUT, SCENARIO_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { branches, snapshotRepo } from "../helpers/git.ts";
import { requireRunnerState } from "../helpers/runner.ts";
import { byTestId, cardInPanel, messageBySeq, onlyOn, press, uniqueMarker } from "../helpers/ui.ts";
import { flick } from "../helpers/swipe.ts";

test("E52 既存リポジトリでプロジェクトを立てて仕事を承認しても、本体は変わらずブランチだけが残る", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(360_000);
  const { sampleRepo } = requireRunnerState();
  const before = snapshotRepo(sampleRepo);

  // ランナーがリポジトリの候補として sample-repo を見つけている（3.2。<BATON_PROJECTS_ROOT>/*/*/）
  await expect.poll(async () => (await api.repos()).some((r) => r.path === sampleRepo), { message: "sample-repo が候補にある", timeout: 30_000 }).toBe(true);

  const marker = uniqueMarker("E52", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  await page.goto("/");
  await api.sayToCoo(`${marker} ${MARK.propose} ${MARK.repo} sample-repo で小さな改善を続けたい`);

  // プロジェクト案のカード（COO の発言 kind=project_proposal）
  const proposalMsg = await api.waitForMessage(COO_THREAD_ID, { authorKind: "coo", kind: "project_proposal", afterSeq: start });
  const card = messageBySeq(page, proposalMsg.seq).locator(`[data-testid="${TESTIDS.proposalCard}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "pending");
  await expect(card).toContainText(UI_TEXT_V2.proposal.title);
  await expect(card).toContainText(UI_TEXT_V2.proposal.goal);
  await expect(card).toContainText(UI_TEXT_V2.proposal.team);
  // プロジェクト案は立てるまでプロジェクトにならない
  const proposalId = await card.getAttribute("data-proposal-id");
  expect(proposalId).toBeTruthy();

  // 作業場所: `既存リポジトリ` → sample-repo を選ぶ（作業中の変更ありの印）→ `立てる`
  const ws = byTestId(card, TESTIDS.proposalWorkspace);
  await ws.getByText(UI_TEXT_V2.proposal.repo, { exact: true }).click();
  const option = card.locator(`[data-testid="${TESTIDS.proposalRepoOption}"][data-path="${sampleRepo}"]`);
  await expect(option).toBeVisible();
  await expect(option).toContainText(UI_TEXT_V2.proposal.dirty);
  await option.click();
  await press(byTestId(card, TESTIDS.proposalAccept), testInfo);
  await expect(card).toHaveAttribute("data-status", "accepted");
  await expect(card).toContainText(UI_TEXT_V2.proposal.accepted);

  // プロジェクトが既存リポジトリで立ち、COO が最初の仕事をリーダーに振る
  const project = (await api.projects()).find((p) => p.repoPath === sampleRepo);
  expect(project, "sample-repo に紐づいたプロジェクト").toBeTruthy();
  expect(project!.workspaceKind).toBe("repo");
  await api.leaderThread(project!.id);
  let instructionId = "";
  await expect
    .poll(async () => {
      instructionId = (await api.list("active", project!.id))[0]?.id ?? "";
      return instructionId;
    }, { message: "最初の仕事（指示）ができる", timeout: RUNNER_TIMEOUT })
    .not.toBe("");
  await api.waitForStatus(instructionId, "review", SCENARIO_TIMEOUT);
  // 作業中も本体は変わらない
  expect(snapshotRepo(sampleRepo), "作業中も本体（HEAD・ブランチ・作業ツリー・index・remote）が変わらない").toEqual(before);

  // 承認 → 20 秒後に確定（既存リポジトリは取り込まない。統合用ブランチを残す）
  const cardEl = await cardInPanel(page, testInfo, instructionId);
  await flick(page, cardEl, "right");
  await api.waitForStatus(instructionId, "done", 15_000);
  const d = await api.waitForDetail(instructionId, (x) => x.instruction.finalizedAt !== null, "確定", FINALIZE_DELAY_MS + 60_000);
  const id8 = instructionId.slice(0, 8);
  expect(d.workspaces.find((w) => w.purpose === "integration")?.status).toBe("kept");
  expect(branches(sampleRepo, `baton/${id8}/*`), "統合用ブランチだけが残る").toEqual([`baton/${id8}/integration`]);
  expect(snapshotRepo(sampleRepo), "確定のあとも本体が変わらない（push もしない）").toEqual(before);

  // 詳細の作業場所のチップにブランチ名
  await page.goto(`/i/${instructionId}`);
  await expect(byTestId(page, TESTIDS.branchChip).first()).toContainText(`baton/${id8}/integration`);
});
