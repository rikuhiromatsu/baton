// R20 正規化と送信・ストリーム（4.7・8.3・8.4）: トランスクリプトは seq の通し番号でまとめて送る（50 件まで）。
// 返事は text_delta を 100ms ごとに送り、道具の前の文章は reset。StructuredOutput では reset しない（D-100）。生ログは全文を jsonl に。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID, LIMITS } from "@baton/shared";
import { StreamSink, TranscriptSink } from "../src/claude/sink.ts";
import { silentLogger } from "../src/log.ts";
import { FakeBatonApi } from "./fakes/fake-api.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R20 正規化と送信", () => {
  it("シナリオ A の 1 ターン: 項目の seq が通し番号、返事の差分を継ぎ足すと本文になる、生ログに全行", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    await env.step();
    const items = env.api.transcript;
    expect(items.map((i) => i.seq)).toEqual(items.map((_, i) => i + 1));
    expect(items[0]!.kind).toBe("user");
    expect(items[0]!.author).toBe("ceo");
    expect(items.some((i) => i.kind === "output" && i.summary === "結論")).toBe(true);
    expect(items.at(-1)!.kind).toBe("result");
    const msg = env.api.messagesOf(COO_THREAD_ID).find((m) => m.authorKind === "coo")!;
    let text = "";
    for (const s of env.api.streams.filter((x) => x.messageId === msg.id)) {
      if (s.reset) text = "";
      expect(s.offset).toBe(text.length);
      text += s.delta;
    }
    expect(text).toBe(msg.body);
    const day = (await readdir(path.join(env.dataDir, "logs")))[0]!;
    const raw = await readFile(path.join(env.dataDir, "logs", day, `${msg.sessionId}.jsonl`), "utf8");
    expect(raw.split("\n").filter(Boolean).every((l) => JSON.parse(l))).toBe(true);
    expect(raw).toContain('"type":"result"');
  }, 30_000);

  it("TranscriptSink: 50 件ごとに送り、5,000 件を超えたら tool_result の body を空に", async () => {
    const api = new FakeBatonApi();
    const sink = new TranscriptSink({ api, log: silentLogger, flushMs: 5 }, "s1", null, null);
    for (let i = 0; i < 120; i++) sink.add({ kind: "text", author: "claude", toolName: null, toolUseId: null, parentToolUseId: null, summary: `t${i}`, body: { text: "x" }, truncated: false, isError: false });
    await sink.flush();
    expect(api.transcript).toHaveLength(120);
    expect(api.transcript.map((t) => t.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    const big = new TranscriptSink({ api, log: silentLogger, flushMs: 5 }, "s2", null, null, 0);
    (big as unknown as { count: number }).count = LIMITS.itemsPerSession;
    big.add({ kind: "tool_result", author: "claude", toolName: "Read", toolUseId: "t", parentToolUseId: null, summary: "x", body: { text: "y" }, truncated: false, isError: false });
    await big.flush();
    expect(api.transcript.at(-1)!.body).toEqual({});
  });

  it("StreamSink: 4,000 文字ごとに分け、reset で offset を 0 に戻し、activity も送る", async () => {
    const api = new FakeBatonApi();
    const s = new StreamSink({ api, flushMs: 5 }, "th", "m");
    s.append("a".repeat(4500));
    s.setActivity("読んでいる org.md");
    await s.flush();
    expect(api.streams.map((x) => [x.offset, x.delta.length])).toEqual([
      [0, 4000],
      [4000, 500],
    ]);
    expect(api.streams[0]!.activity).toBe("読んでいる org.md");
    s.reset();
    s.append("本文");
    await s.flush();
    expect(api.streams.at(-1)).toMatchObject({ offset: 0, delta: "本文", reset: true });
  });
});
