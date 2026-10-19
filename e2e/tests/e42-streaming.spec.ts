// E42 返事のストリーミング（DESIGN-v2 4.7・D-80）: COO の返事の文字数が少しずつ増えていく。途中で再読み込みしても
// streaming の発言は REST の本文から表示され、続きが届いて完成する。台本: [long]（長い返事を 10 文字ずつ）と [slow]
import { COO_THREAD_ID } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { messageBySeq, onlyOn, uniqueMarker, visibleMessages } from "../helpers/ui.ts";

test("E42 COO の返事が少しずつ伸び、再読み込みしても続きが届いて完成する", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  const marker = uniqueMarker("E42", testInfo);
  const start = await api.lastSeq(COO_THREAD_ID);
  await page.goto("/");
  await api.sayToCoo(`${marker} ${MARK.long} ${MARK.slow} 長い返事で`);

  // ストリーミング中の COO の発言
  let seq = -1;
  await expect
    .poll(async () => {
      const hit = (await visibleMessages(page)).find((m) => m.author === "coo" && m.seq > start && m.status === "streaming");
      seq = hit?.seq ?? -1;
      return seq;
    }, { message: "ストリーミング中の COO の発言", timeout: RUNNER_TIMEOUT, intervals: [100, 200] })
    .toBeGreaterThan(-1);

  // 文字数が増えていく（少なくとも 3 回、違う長さを観測する）
  const lengths: number[] = [];
  const bubble = messageBySeq(page, seq);
  for (let i = 0; i < 40 && new Set(lengths).size < 3; i++) {
    const status = await bubble.getAttribute("data-status");
    lengths.push((await bubble.innerText()).length);
    if (status !== "streaming") break;
    await page.waitForTimeout(150);
  }
  expect(new Set(lengths).size, `本文の長さの移り変わり: ${lengths.join(", ")}`).toBeGreaterThanOrEqual(3);
  expect([...lengths].sort((a, b) => a - b), "長さは減らない").toEqual(lengths);

  // 途中で再読み込み → REST の本文から表示され、続きが届いて完成する
  const beforeReload = lengths[lengths.length - 1]!;
  await page.reload();
  const again = messageBySeq(page, seq);
  await expect(again).toBeVisible();
  await expect(again).toHaveAttribute("data-status", "complete", { timeout: RUNNER_TIMEOUT });
  const finalLen = (await again.innerText()).length;
  expect(finalLen).toBeGreaterThan(beforeReload);
  const stored = (await api.findMessages(COO_THREAD_ID, { authorKind: "coo", afterSeq: start })).find((m) => m.seq === seq);
  expect(stored?.body.length ?? 0, "完成した本文は REST でも同じ長さ").toBeGreaterThan(200);
});
