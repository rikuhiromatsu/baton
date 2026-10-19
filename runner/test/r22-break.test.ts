// R22 会話の区切り（4.6・D-78）: Worker が受信箱に入れた [会話の区切り] でリーダーのターンを起こし、
// まだ COO に伝えていない CEO の発言があれば cooReport → COO スレッドに leader_report（COO のターンは起こさない）。
// 区切りを見つけるのは Worker（D1 の未報告と最後の発言の時刻。BATON_CONVERSATION_BREAK_MS）。ランナーは札にして渡すだけ。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID, parseTurnInput } from "@baton/shared";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R22 会話の区切り", () => {
  it("区切りの受信箱 → [会話の区切り] の札 → 未報告があれば cooReport → leader_report（wakes=0）", async () => {
    env = await makeEnv();
    const p = env.api.addProject({ slug: "demo", name: "デモ" });
    const leaderThread = `thread-${p.id}`;
    env.api.ceoSays(leaderThread, "資料の構成を変えて [no-report]");
    await env.step();
    expect(env.api.agentMessages(COO_THREAD_ID).some((m) => m.kind === "leader_report")).toBe(false);
    // Worker が区切りを入れる
    await env.api.pushInbox(leaderThread, { kind: "instruction_event", wakes: true, payload: { type: "conversation_break", text: "まだ COO に伝えていないことがあれば cooReport で" } });
    let r = await env.step();
    while (r && r.kind !== "thread") r = await env.step();
    const input = env.api.transcript.filter((t) => t.kind === "user").at(-1)!;
    expect(parseTurnInput(String((input.body as { text: string }).text)).map((l) => l.tag)).toContain("[会話の区切り]");
    const lr = env.api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "leader_report")!;
    expect(lr.body).toContain("CEO と話した内容");
    expect(lr.authorAgentId).toBe(`${p.id}-leader`);
    expect(lr.ref).toMatchObject({ threadId: leaderThread });
    expect(env.api.pendingInbox(COO_THREAD_ID).filter((i) => i.kind === "leader_report").every((i) => !i.wakes)).toBe(true);
  }, 30_000);

  it("CEO と話したターンで方針が変わったら、そのターンで cooReport（版 +1）", async () => {
    env = await makeEnv();
    const p = env.api.addProject({ slug: "demo", name: "デモ" });
    env.api.ceoSays(`thread-${p.id}`, "新しく調べものを頼みたい");
    await env.step();
    const lr = env.api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "leader_report")!;
    expect(lr.body).toContain("新しく調べものを頼みたい");
    // 新しい仕事（instructionId: null の plan）で指示ができ、リーダーのスレッドが元
    const i = [...env.api.instructions.values()][0]!;
    expect(i.originThreadId).toBe(`thread-${p.id}`);
    expect(i.body).toContain("新しく調べものを頼みたい");
    // CEO の発言で起きたターンの返事は通知する
    expect(env.api.agentMessages(`thread-${p.id}`).find((m) => m.authorKind === "leader")!.notify).toBe(true);
  }, 30_000);
});
