// R5 メンバーの質問（5.6）: ask_leader → セッション paused（question）→ リーダーの受信箱に member_question →
// リーダーの answer_member → 同じセッションに [リーダー] の答えが流れて続く。リーダーが答えられなければ ask_coo → COO の answer_leader。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R5 ask_leader と ask_coo", () => {
  it("メンバーの質問にリーダーが答え、同じセッションで続く", async () => {
    env = await makeEnv();
    const { api } = env;
    api.ceoSays(COO_THREAD_ID, "表を作って [ask]");
    await env.step();
    await env.step();
    const member = env.step(); // メンバーが質問して答えを待つ
    await waitFor(() => api.inbox.some((i) => i.kind === "member_question"));
    const q = api.inbox.find((i) => i.kind === "member_question")!;
    const sid = q.payload.sessionId as string;
    expect(api.sessions.get(sid)!.status).toBe("paused");
    expect(api.sessions.get(sid)!.pauseReason).toBe("question");
    // リーダーのターン（並行して）
    const leader = env.step();
    await Promise.all([member, leader]);
    expect(api.sessions.get(sid)!.status).toBe("done");
    expect([...api.sessions.values()].filter((s) => s.role === "member")).toHaveLength(1);
    expect(api.transcript.some((t) => t.sessionId === sid && t.kind === "user" && String((t.body as { text?: string }).text).startsWith("[リーダー] A 案"))).toBe(true);
    expect([...api.tasks.values()][0]!.status).toBe("done");
  }, 30_000);

  it("リーダーの ask_coo は COO の受信箱に delegation（question）で入り、COO の answer_leader がリーダーへ", async () => {
    env = await makeEnv();
    const { api } = env;
    api.ceoSays(COO_THREAD_ID, "調べて [ask-coo]");
    await env.step(); // COO delegate
    await env.step(); // リーダー ask_coo
    const q = api.inbox.find((i) => i.threadId === COO_THREAD_ID && i.kind === "delegation")!;
    expect(q.payload.question).toBe("優先する観点はどれですか？");
    await env.step(); // COO answer_leader
    const project = [...api.projects.values()][0]!;
    const leaderThread = `thread-${project.id}`;
    expect(api.messagesOf(leaderThread).some((m) => m.authorKind === "coo" && m.body.includes("おまかせします"))).toBe(true);
    await env.drain();
    expect([...api.tasks.values()].length).toBeGreaterThan(0);
  }, 30_000);

  it("追加の依頼（5.6）: 終わったメンバーに --resume で渡し、結果はそのタスクだけリーダーへ（ラウンドのまとめは出し直さない）", async () => {
    env = await makeEnv();
    const { api } = env;
    api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await env.step();
    await env.step();
    await env.step();
    const s = [...api.sessions.values()].find((x) => x.role === "member")!;
    expect(s.status).toBe("done");
    const before = api.inbox.filter((i) => i.kind === "member_results").length;
    const input = api.addSessionInput(s.id, "見出しを足して");
    let r = await env.step();
    while (r && r.kind !== "instruction") r = await env.step();
    expect(r?.kind).toBe("instruction");
    expect(api.inputs.find((x) => x.id === input.id)!.status).toBe("delivered");
    expect(api.sessions.get(s.id)!.status).toBe("done");
    const results = api.inbox.filter((i) => i.kind === "member_results");
    expect(results.length).toBe(before + 1);
    expect(String(JSON.stringify(results.at(-1)!.payload))).toContain("追加の依頼に対応しました");
    expect(api.transcript.some((t) => t.sessionId === s.id && String((t.body as { text?: string }).text ?? "").startsWith("[CEO の追加の依頼] 見出しを足して"))).toBe(true);
  }, 30_000);
});
