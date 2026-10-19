// E53 並行と衝突＝シナリオ B2（DESIGN-v2 7.4・14.2、D-82）: [conflict] でリーダーが paths の重なる 2 タスクを並行で出す →
// 統合で `衝突`（merge_conflict）→ リーダーが resolve_conflict → 解決タスクのメンバーが直して統合済み → 確認。
// 承認前は Baton 専用の本体の main は変わらない
import { TURN_TAGS, UI_TEXT_V2 } from "@baton/shared";
import { MARK, PROJECTS, SCENARIO_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { git, tryGit } from "../helpers/git.ts";
import { batonProjectDir } from "../helpers/runner.ts";
import { onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E53 並行タスクの衝突をリーダーの解決タスクで統合し、本体は承認まで変わらない", async ({ api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(360_000);
  const marker = uniqueMarker("E53", testInfo);
  const created = await api.createInstructionViaChat(marker, `${MARK.conflict} 同じファイルを 2 人で直す`);
  const project = await api.project(created.projectId!);
  const repo = batonProjectDir(project.slug);
  await expect.poll(() => tryGit(repo, "rev-parse", "main"), { message: "Baton 専用の本体が git で管理されている" }).not.toBeNull();
  const mainBefore = git(repo, "rev-parse", "main");

  // 衝突した（タスク用の worktree が conflict になった）
  const conflicted = await api.waitForDetail(
    created.id,
    (d) => d.workspaces.some((w) => w.purpose === "task" && w.status === "conflict"),
    "統合で衝突する",
    SCENARIO_TIMEOUT,
  );
  const conflictTask = conflicted.workspaces.find((w) => w.status === "conflict")!;

  // リーダーに [衝突] が渡り、解決タスクができて統合される → 確認
  const d = await api.waitForStatus(created.id, "review", SCENARIO_TIMEOUT);
  const leaderSession = d.sessions.find((s) => s.role === "leader");
  expect(leaderSession).toBeTruthy();
  const leaderItems = await api.transcript(leaderSession!.id, { instructionId: created.id });
  expect(leaderItems.some((i) => i.kind === "user" && JSON.stringify(i.body).includes(TURN_TAGS.mergeConflict)), "リーダーに [衝突] が渡る").toBe(true);
  expect(d.tasks.length, "解決タスクが足される").toBeGreaterThanOrEqual(3);
  const taskWs = d.workspaces.filter((w) => w.purpose === "task");
  expect(taskWs.filter((w) => w.status === "merged").length, "解決タスクを含めて統合された").toBeGreaterThanOrEqual(2);
  expect(taskWs.find((w) => w.id === conflictTask.id)?.status, "衝突した worktree は残るか解決で統合済み").toMatch(/^(conflict|merged|removed)$/);
  // ランナーの出来事として `衝突` と `統合` がトランスクリプトに残る
  const all = (await Promise.all(d.sessions.map((s) => api.transcript(s.id, { instructionId: created.id })))).flat();
  expect(all.some((i) => i.kind === "system" && i.summary.includes(UI_TEXT_V2.transcript.conflict)), "トランスクリプトに「衝突」").toBe(true);
  expect(all.some((i) => i.kind === "system" && i.summary.includes(UI_TEXT_V2.transcript.integrate)), "トランスクリプトに「統合」").toBe(true);

  // 承認前は本体の main が変わらない
  expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
});
