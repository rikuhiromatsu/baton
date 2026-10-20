// R28 返事を待つのに本文が空のターン（本番の Opus が返事を思考の中だけに書き、reply: null・awaitingReply: true・行動なしで終えた）。
// ランナーは同じセッションに 1 回だけ頼み直し、CEO に返事を届ける。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { SILENT_REPLY_RETRY, isSilentAsk } from "../src/orchestrator/thread.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R28 本文が空の返事待ち", () => {
  it("頼み直して返事が届き、返事待ちになる。CEO の発言は二重に送らない", async () => {
    env = await makeEnv();
    const { api } = env;
    api.ceoSays(COO_THREAD_ID, "[silent-ask] 相談があります");
    const r = await env.step();
    expect(r?.kind).toBe("thread");
    expect(api.agentMessages(COO_THREAD_ID).map((m) => m.body)).toEqual(["ご依頼の中身をもう少し教えてください。"]);
    expect(api.threads.get(COO_THREAD_ID)!.awaitingReply).toBe(true);
    expect(api.instructions.size).toBe(0);
    const inputs = api.transcript.filter((t) => t.kind === "user").map((t) => String((t.body as { text: string }).text));
    expect(inputs.filter((t) => t.includes("相談があります"))).toHaveLength(1);
    expect(inputs.at(-1)).toContain(SILENT_REPLY_RETRY);
  }, 30_000);

  it("相づちへの無言（awaitingReply: false）や行動だけのターンは頼み直さない", () => {
    expect(isSilentAsk({ awaitingReply: false, reply: null, actions: [] }, "")).toBe(false);
    expect(isSilentAsk({ awaitingReply: true, reply: null, actions: [{}] }, "")).toBe(false);
    expect(isSilentAsk({ awaitingReply: true, reply: "はい", actions: [] }, "")).toBe(false);
    expect(isSilentAsk({ awaitingReply: true, reply: null, actions: [] }, "なんの動画ですか？")).toBe(false);
    expect(isSilentAsk({ awaitingReply: true, reply: null, actions: [] }, "  ")).toBe(true);
  });
});
