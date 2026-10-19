// R22 会話の区切り（4.6・D-78）: CEO の最後の発言から一定時間たって、COO に未報告の CEO の発言があればリーダーの受信箱に
// [会話の区切り] を入れてターンを起こす。未報告が無ければ区切りのターンは claude を起こさずに終える。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R22 会話の区切り", () => {
  it("未報告の CEO の発言があれば区切りでリーダーが cooReport → COO スレッドに leader_report", async () => {
    env = await makeEnv({ env: { BATON_CONVERSATION_BREAK_MS: "200" } });
    const p = env.api.addProject({ slug: "demo", name: "デモ" });
    const leaderThread = `thread-${p.id}`;
    env.api.ceoSays(leaderThread, "資料の構成を変えて [no-report]");
    await env.step();
    expect(env.api.agentMessages(COO_THREAD_ID).some((m) => m.kind === "leader_report")).toBe(false);
    expect(env.ctx.coord.unreported.has(leaderThread)).toBe(true);
    await waitFor(() => env.api.pendingInbox(leaderThread).some((i) => i.payload.type === "conversation_break"), 3000);
    // 区切りのターン（メンバーの段階より先に取る）
    let r = await env.step();
    while (r && r.kind !== "thread") r = await env.step();
    const lr = env.api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "leader_report")!;
    expect(lr.body).toContain("CEO と話した内容");
    expect(env.ctx.coord.unreported.has(leaderThread)).toBe(false);
  }, 30_000);

  it("未報告が無ければ区切りの受信箱は claude を起こさずに消化", async () => {
    env = await makeEnv();
    const p = env.api.addProject({ slug: "demo", name: "デモ" });
    const leaderThread = `thread-${p.id}`;
    await env.api.pushInbox(leaderThread, { kind: "instruction_event", wakes: true, payload: { type: "conversation_break" } });
    const r = await env.step();
    expect(r?.outcome).toBe("skipped");
    expect(env.api.sessions.size).toBe(0);
    expect(env.api.pendingInbox(leaderThread)).toHaveLength(0);
  }, 30_000);
});
