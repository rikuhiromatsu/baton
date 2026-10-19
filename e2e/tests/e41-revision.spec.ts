// E41 シナリオ B1（DESIGN-v2 14.2、4.6・D-79 の版）: COO が present を出す直前に、CEO がリーダーに方針変更を伝える →
// rev 2。COO の rev 1 の present は行われず（保留して見直すか、古い版として捨てる）、COO に [知らせ] が渡る。
// 台本: [slow] で COO の最後のターンを遅らせ、その間にリーダーのスレッドで [scenario-a] の「ニッチ」（リーダーが plan と cooReport direction を返す）
import { COO_THREAD_ID, TURN_TAGS } from "@baton/shared";
import { MARK, PROJECTS, SCENARIO_A, SCENARIO_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { onlyOn, uniqueMarker } from "../helpers/ui.ts";

test("E41 COO の present の直前にリーダーと方針を変えると、古い版の報告は出ず、COO に知らせが渡る", async ({ api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(360_000);
  const marker = uniqueMarker("E41", testInfo);
  const cooStart = await api.lastSeq(COO_THREAD_ID);
  const created = await api.createInstructionViaChat(marker, `${MARK.slow} 版の確認`);
  const leader = await api.leaderThread(created.projectId!);

  // リーダーが成果をまとめて COO の番（phase=coo）になった瞬間に、CEO がリーダーへ方針変更を伝える
  await api.waitForDetail(created.id, (d) => d.instruction.phase === "coo" && d.instruction.status === "running", "COO の番になる", SCENARIO_TIMEOUT);
  const atChange = await api.detail(created.id);
  expect(atChange.instruction.revision).toBe(1);
  await api.postMessage(leader.id, `${MARK.scenarioA} ${marker} ${SCENARIO_A.ceo3}`, { instructionId: created.id });

  // rev 2 になり、リーダーの報告が COO スレッドに残る
  await api.waitForDetail(created.id, (d) => d.instruction.revision === 2, "rev 2 になる");
  const leaderReport = await api.waitForMessage(COO_THREAD_ID, { kind: "leader_report", instructionId: created.id, afterSeq: cooStart });

  // rev 1 の present（報告）は出ない: 最終的な報告は leader_report より後にしか無い
  const final = await api.waitForMessage(COO_THREAD_ID, { authorKind: "coo", kind: "report", instructionId: created.id, afterSeq: cooStart }, SCENARIO_TIMEOUT);
  expect(final.seq, "COO の報告は方針変更の報告のあと").toBeGreaterThan(leaderReport.seq);
  const reports = await api.findMessages(COO_THREAD_ID, { authorKind: "coo", kind: "report", instructionId: created.id, afterSeq: cooStart });
  expect(reports, "報告は 1 回だけ（rev 2 のもの）").toHaveLength(1);
  const d = await api.waitForStatus(created.id, "review", SCENARIO_TIMEOUT);
  expect(d.instruction.revision).toBe(2);

  // COO のセッションのトランスクリプトに「方針が変わった」の [知らせ] が入っている（ランナーが書いた user の項目）
  const cooSessionId = final.sessionId;
  expect(cooSessionId, "COO の発言にセッション ID がある").toBeTruthy();
  const items = await api.transcript(cooSessionId!, { instructionId: created.id });
  const notices = items.filter((i) => i.kind === "user" && JSON.stringify(i.body).includes(TURN_TAGS.notice));
  expect(notices.length, "COO に [知らせ] が渡った").toBeGreaterThan(0);
});
