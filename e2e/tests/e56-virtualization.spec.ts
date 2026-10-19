// E56 長い会話と長いトランスクリプトの仮想化（DESIGN-v2 13.4・13.7、@tanstack/react-virtual）。
// 実際に数百件の発言を作るとレート制限（1 分 30 件）と台本に縛られるので、取得 API の応答をテストが差し替えて
// 「最新 100 件 + 前がある」を返し、DOM の要素数が件数より少ないこと・上へスクロールすると before= で前を取ることを見る
import {
  API_PATHS,
  COO_THREAD_ID,
  TESTIDS,
  type ListMessagesOutput,
  type ThreadMessage,
  type TranscriptItem,
  type TranscriptOutput,
} from "@baton/shared";
import { PROJECTS } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { byTestId, onlyOn, uniqueMarker } from "../helpers/ui.ts";

const BASE_SEQ = 900_000;

function fakeMessage(seq: number, now: number): ThreadMessage {
  const ceo = seq % 2 === 0;
  return {
    id: `e56-msg-${seq}`,
    threadId: COO_THREAD_ID,
    seq,
    authorKind: ceo ? "ceo" : "coo",
    authorAgentId: ceo ? null : "agent-coo",
    authorName: ceo ? null : "COO",
    kind: "chat",
    body: `E56 の発言 ${seq}\n${"長い会話の行。".repeat(4)}`,
    instructionId: null,
    sessionId: null,
    ref: {},
    status: "complete",
    reaction: null,
    notify: false,
    clientId: ceo ? `e56-${seq}` : null,
    createdAt: now - (BASE_SEQ + 300 - seq) * 1000,
    updatedAt: now - (BASE_SEQ + 300 - seq) * 1000,
  };
}

function fakeItem(sessionId: string, instructionId: string, seq: number, now: number): TranscriptItem {
  return {
    id: `e56-item-${seq}`,
    sessionId,
    threadId: null,
    instructionId,
    seq,
    kind: "text",
    author: "claude",
    toolName: null,
    toolUseId: null,
    parentToolUseId: null,
    summary: `E56 のやりとり ${seq}`,
    body: { text: `E56 のやりとり ${seq}\n${"作業の記録。".repeat(6)}` },
    truncated: false,
    isError: false,
    createdAt: now - (1000 - seq) * 1000,
  };
}

test("E56 長い会話と長いトランスクリプトは仮想化され、上へスクロールすると前を取る", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const now = Date.now();

  // ───── 会話: 最新 100 件（seq 900101〜900200）＋前がある。before= で 900001〜900100 ─────
  const beforeParams: string[] = [];
  await page.route(
    (url) => url.pathname === API_PATHS.threadMessages(COO_THREAD_ID),
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const url = new URL(route.request().url());
      const before = url.searchParams.get("before");
      let body: ListMessagesOutput;
      if (before) {
        beforeParams.push(before);
        body = { items: Array.from({ length: 100 }, (_, i) => fakeMessage(BASE_SEQ + 1 + i, now)), hasMoreBefore: false };
      } else {
        body = { items: Array.from({ length: 100 }, (_, i) => fakeMessage(BASE_SEQ + 101 + i, now)), hasMoreBefore: true };
      }
      await route.fulfill({ json: body });
    },
  );
  await page.goto("/");
  const thread = byTestId(page, TESTIDS.thread).first();
  // 最新が見えている（追従）
  await expect(page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${BASE_SEQ + 200}"]`)).toBeVisible();
  const rendered = await thread.locator(`[data-testid="${TESTIDS.message}"]`).count();
  expect(rendered, `DOM の発言は 100 件より少ない（仮想化。いま ${rendered} 件）`).toBeLessThan(100);

  // 上へスクロールし続けると before= で前の 100 件を取り、一番古い発言まで行ける
  await expect
    .poll(
      async () => {
        await thread.evaluate((el) => {
          const scroller = [el, ...Array.from(el.querySelectorAll("*"))].find((e) => e.scrollHeight > e.clientHeight + 10) ?? el;
          scroller.scrollTop = 0;
        });
        return page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${BASE_SEQ + 1}"]`).count();
      },
      { message: "一番古い発言（before= で取った分）まで遡れる", timeout: 20_000, intervals: [300, 500] },
    )
    .toBe(1);
  expect(beforeParams[0], "before= は最新 100 件の一番古い seq").toBe(String(BASE_SEQ + 101));
  expect(await thread.locator(`[data-testid="${TESTIDS.message}"]`).count()).toBeLessThan(200);
  // 「最新へ」のピルで下に戻れる
  const pill = byTestId(page, TESTIDS.latestPill);
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${BASE_SEQ + 200}"]`)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // ───── トランスクリプト: 最新 200 件＋前がある ─────
  const marker = uniqueMarker("E56", testInfo);
  const { instruction } = await api.createAndWait(marker, "トランスクリプトの仮想化");
  const d = await api.detail(instruction.id);
  const member = d.sessions.find((s) => s.role === "member")!;
  await page.route(
    (url) => url.pathname === API_PATHS.sessionTranscript(member.id),
    async (route) => {
      const url = new URL(route.request().url());
      const before = url.searchParams.get("before");
      const body: TranscriptOutput = before
        ? { items: Array.from({ length: 200 }, (_, i) => fakeItem(member.id, instruction.id, 1 + i, now)), hasMoreBefore: false }
        : { items: Array.from({ length: 200 }, (_, i) => fakeItem(member.id, instruction.id, 201 + i, now)), hasMoreBefore: true };
      await route.fulfill({ json: body });
    },
  );
  await page.goto(`/i/${instruction.id}?s=${member.id}`);
  const transcript = byTestId(page, TESTIDS.transcript);
  await expect(transcript).toBeVisible();
  await expect(transcript.locator(`[data-testid="${TESTIDS.transcriptItem}"]`).first()).toBeVisible();
  const items = await transcript.locator(`[data-testid="${TESTIDS.transcriptItem}"]`).count();
  expect(items, `DOM の項目は 200 件より少ない（仮想化。いま ${items} 件）`).toBeLessThan(200);
  await expect(transcript.locator(`[data-testid="${TESTIDS.transcriptItem}"][data-seq="400"]`)).toBeVisible();
});
