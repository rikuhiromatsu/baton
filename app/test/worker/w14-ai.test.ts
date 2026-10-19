// W14 AI 代理: 日上限・指示上限で 429、ScriptedAiClient の応答の正規化、退避先、ai_usage の記録。normalizeAiResult の実物 fixture
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AiChatOutput, CooFinalAction, CooRouteAction, LeaderPlanAction, LIMITS, MemberStepAction, UsageTodaySchema } from "@baton/shared";
import { extractFirstJsonObject, normalizeAiResult } from "../../src/worker/ai/normalize.ts";
import { scriptedResponse } from "../../src/worker/ai/scripted-ai.ts";
import { utcDay } from "../../src/worker/lib/time.ts";
import gptOss120b from "../fixtures/ai/openai__gpt-oss-120b.json";
import gptOss20b from "../fixtures/ai/openai__gpt-oss-20b.json";
import glm from "../fixtures/ai/zai-org__glm-4.7-flash.json";
import llama from "../fixtures/ai/meta__llama-3.3-70b-instruct-fp8-fast.json";
import granite from "../fixtures/ai/ibm-granite__granite-4.0-h-micro.json";
import { BASE, browser, callWithEnv, clearQueue, createInstruction, login, registerRunner, runner, type TestRunner } from "./helpers.ts";

type Msg = { role: "system" | "user" | "assistant"; content: string };
const sys = (stage: string) => ({ role: "system" as const, content: `ROLE: ${stage}\nあなたは…` });
const userMsg = (body: string, extra: string[] = []) => ({ role: "user" as const, content: `<<<input>>>\n${body}\n<<<end>>>\n${extra.join("\n")}` });

let r: TestRunner;
let instructionId: string;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ai_usage").run();
  const s = await login();
  r = await registerRunner();
  await clearQueue();
  instructionId = (await createInstruction(s, "AI のテスト")).id;
  const c = await runner(r, "/api/runner/claim", { body: { maxConcurrent: 2, activeIds: [] } });
  expect(c.status).toBe(200);
});

function chatBody(messages: Msg[], extra: Record<string, unknown> = {}) {
  return { instructionId, role: "coo", messages, maxCompletionTokens: 2048, jsonSchema: { name: "action", schema: { type: "object" } }, ...extra };
}

async function chat(messages: Msg[], extra: Record<string, unknown> = {}) {
  return runner(r, "/api/runner/ai/chat", { body: chatBody(messages, extra) });
}

/** 偽の env.AI を差して呼ぶ（WorkersAiClient の経路） */
async function chatWithAi(ai: { run: (model: string, input: unknown) => Promise<unknown> }, messages: Msg[], extra: Record<string, unknown> = {}, envOver: Record<string, unknown> = {}) {
  return callWithEnv({ AI: ai as unknown as Ai, ...envOver }, `${BASE}/api/runner/ai/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${r.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(chatBody(messages, extra)),
  });
}

const okRaw = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

describe("W14 上限", () => {
  it("日上限に達していたら 429 ai_quota（retryAt は次の UTC 0 時）", async () => {
    await env.DB.prepare("INSERT INTO ai_usage (id, day, model, role, tokens_in, tokens_out, created_at) VALUES (?, ?, 'm', 'coo', ?, 0, ?)")
      .bind(crypto.randomUUID(), utcDay(Date.now()), LIMITS.tokensPerDay, Date.now())
      .run();
    const res = await chat([sys("coo_route"), userMsg("x")]);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; details: { scope: string; retryAt: number } } };
    expect(body.error.code).toBe("ai_quota");
    expect(body.error.details.scope).toBe("day");
    const d = new Date();
    expect(body.error.details.retryAt).toBe(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  });

  it("指示上限に達していたら 429 ai_quota（scope=instruction）", async () => {
    await env.DB.prepare("UPDATE instructions SET tokens_in = ?, tokens_out = 1 WHERE id = ?").bind(LIMITS.tokensPerInstruction - 1, instructionId).run();
    const res = await chat([sys("coo_route"), userMsg("x")]);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "ai_quota", details: { scope: "instruction" } } });
  });
});

describe("W14 ScriptedAiClient（env.AI が無い e2e 環境）", () => {
  it("coo_route の応答が正規化され、ai_usage と指示のトークンに記録される", async () => {
    const res = await chat([sys("coo_route"), userMsg("市場調査をして競合を 3 社まとめてください")]);
    expect(res.status).toBe(200);
    const out = AiChatOutput.parse(await res.json());
    expect(out).toMatchObject({ model: "@cf/openai/gpt-oss-120b", usedFallback: false });
    const action = CooRouteAction.parse(JSON.parse(out.text));
    expect(action).toMatchObject({ kind: "route", title: "市場調査をして競合を 3 社まとめてくだ", project: { mode: "new", slug: "test", name: "テスト" } });
    expect(out.usage.tokensIn).toBeGreaterThan(0);
    const usage = await env.DB.prepare("SELECT * FROM ai_usage WHERE instruction_id = ?").bind(instructionId).all<{ model: string; role: string; tokens_in: number; tokens_out: number }>();
    expect(usage.results).toHaveLength(1);
    expect(usage.results[0]).toMatchObject({ model: "@cf/openai/gpt-oss-120b", role: "coo", tokens_in: out.usage.tokensIn, tokens_out: out.usage.tokensOut });
    const inst = await env.DB.prepare("SELECT tokens_in, tokens_out FROM instructions WHERE id = ?").bind(instructionId).first();
    expect(inst).toEqual({ tokens_in: out.usage.tokensIn, tokens_out: out.usage.tokensOut });
    const s = await login();
    const today = UsageTodaySchema.parse(await (await browser(s, "/api/usage/today")).json());
    expect(today.byModel.find((m) => m.model === "@cf/openai/gpt-oss-120b")?.tokensIn).toBe(out.usage.tokensIn);
    expect(today.dailyTokenLimit).toBe(LIMITS.tokensPerDay);
  });

  it("[ask] は ask_ceo、CEO_ANSWER があれば route", async () => {
    const ask = AiChatOutput.parse(await (await chat([sys("coo_route"), userMsg("[ask] どっちがいい")])).json());
    expect(CooRouteAction.parse(JSON.parse(ask.text))).toMatchObject({ kind: "ask_ceo", options: ["A案", "B案"] });
    const answered = AiChatOutput.parse(await (await chat([sys("coo_route"), userMsg("[ask] どっちがいい", ["CEO_ANSWER: A案"])])).json());
    expect(JSON.parse(answered.text).kind).toBe("route");
  });

  it("leader_plan・member_step・leader_review・coo_final", async () => {
    const plan = AiChatOutput.parse(await (await chat([sys("leader_plan"), userMsg("x", ["MEMBER: 調査担当 — 調べもの"])], { role: "leader" })).json());
    expect(plan.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(LeaderPlanAction.parse(JSON.parse(plan.text))).toMatchObject({ kind: "plan", tasks: [{ key: "t1", assignee: "調査担当" }, { key: "t2", assignee: "執筆担当" }] });
    const step1 = JSON.parse(AiChatOutput.parse(await (await chat([sys("member_step"), userMsg("x", ["TASK_KEY: t2"])], { role: "member" })).json()).text);
    expect(MemberStepAction.parse(step1)).toMatchObject({ kind: "tool", tool: "fs_write", args: { path: "notes/t2.md" } });
    const step2 = JSON.parse(
      AiChatOutput.parse(
        await (await chat([sys("member_step"), userMsg("x", ["TASK_KEY: t2"]), { role: "assistant", content: "{}" }, { role: "user", content: "TOOL_RESULT fs_write: ok" }], { role: "member" })).json(),
      ).text,
    );
    expect(MemberStepAction.parse(step2)).toMatchObject({ kind: "done", artifacts: [{ path: "notes/t2.md" }] });
    const fail = JSON.parse(AiChatOutput.parse(await (await chat([sys("member_step"), userMsg("[fail] x", ["TASK_KEY: t1"])], { role: "member" })).json()).text);
    expect(fail.kind).toBe("give_up");
    expect(JSON.parse(AiChatOutput.parse(await (await chat([sys("leader_review"), userMsg("x")], { role: "leader" })).json()).text).kind).toBe("report");
    const final = CooFinalAction.parse(JSON.parse(AiChatOutput.parse(await (await chat([sys("coo_final"), userMsg("x")])).json()).text));
    expect(final.report).toContain("テスト報告");
  });

  it("[badjson] は 1 回目に壊れた JSON、JSON_ERROR: の再依頼で直る", async () => {
    const bad = AiChatOutput.parse(await (await chat([sys("coo_route"), userMsg("[badjson] x")])).json());
    expect(() => JSON.parse(bad.text)).toThrow();
    const fixed = AiChatOutput.parse(
      await (await chat([sys("coo_route"), userMsg("[badjson] x"), { role: "assistant", content: bad.text }, { role: "user", content: "JSON_ERROR: 直して" }])).json(),
    );
    expect(JSON.parse(fixed.text).kind).toBe("route");
  });

  it("[quota] は 429 ai_quota（retryAt は 60 秒後）。無料枠切れとしては記録しない", async () => {
    const before = Date.now();
    const res = await chat([sys("coo_route"), userMsg("[quota] x")]);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; details: { retryAt: number } } };
    expect(body.error.code).toBe("ai_quota");
    expect(body.error.details.retryAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(body.error.details.retryAt).toBeLessThan(before + 70_000);
    expect((await chat([sys("coo_route"), userMsg("ふつう")])).status).toBe(200);
  });

  it("[slow] は 1.5 秒遅れる", async () => {
    const t = Date.now();
    expect((await chat([sys("coo_final"), userMsg("[slow] x")])).status).toBe(200);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1400);
  });

  it("util は短い文章", () => {
    expect(scriptedResponse([sys("util"), userMsg("x")])).toBe("テスト要約");
  });
});

describe("W14 Workers AI の経路（偽の env.AI）", () => {
  it("主モデルが失敗したら退避先へ切り替える", async () => {
    const calls: string[] = [];
    const ai = {
      run: async (model: string) => {
        calls.push(model);
        if (model === "@cf/openai/gpt-oss-120b") throw new Error("5xx upstream");
        return okRaw('{"kind":"final","report":"退避先"}');
      },
    };
    const res = await chatWithAi(ai, [sys("coo_final"), userMsg("x")]);
    expect(res.status).toBe(200);
    const out = AiChatOutput.parse(await res.json());
    expect(out).toMatchObject({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", usedFallback: true, usage: { tokensIn: 10, tokensOut: 5 } });
    // 主モデル（response_format あり → なし）→ 退避先
    expect(calls).toEqual(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
    const row = await env.DB.prepare("SELECT model FROM ai_usage WHERE instruction_id = ?").bind(instructionId).first<{ model: string }>();
    expect(row?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("response_format を拒否されたら付けずに同じモデルで呼び直し、本文から最初の JSON を取り出す", async () => {
    const inputs: unknown[] = [];
    const ai = {
      run: async (_model: string, input: unknown) => {
        inputs.push(input);
        if ((input as { response_format?: unknown }).response_format) throw new Error("response_format not supported");
        return { response: 'はい。\n```json\n{"kind":"final","report":"a"}\n```', usage: { prompt_tokens: 3, completion_tokens: 4 } };
      },
    };
    const out = AiChatOutput.parse(await (await chatWithAi(ai, [sys("coo_final"), userMsg("x")])).json());
    expect(out).toMatchObject({ text: '{"kind":"final","report":"a"}', usedFallback: false, model: "@cf/openai/gpt-oss-120b" });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ response_format: { type: "json_schema", json_schema: { name: "action" } }, max_completion_tokens: 2048 });
  });

  it("両方だめなら 503 ai_unavailable", async () => {
    const res = await chatWithAi({ run: async () => Promise.reject(new Error("down")) }, [sys("coo_final"), userMsg("x")]);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "ai_unavailable" } });
  });

  it("無料枠切れは記録して 429、その日はもう呼ばない", async () => {
    let n = 0;
    const ai = {
      run: async () => {
        n++;
        throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons");
      },
    };
    const res = await chatWithAi(ai, [sys("coo_final"), userMsg("x")]);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "ai_quota", details: { scope: "provider" } } });
    expect(n).toBe(1);
    const s = await login();
    const today = UsageTodaySchema.parse(await (await browser(s, "/api/usage/today")).json());
    expect(today.quotaHitAt).not.toBeNull();
    expect(today.byModel.some((m) => m.model.startsWith("__"))).toBe(false);
    expect((await chatWithAi(ai, [sys("coo_final"), userMsg("x")])).status).toBe(429);
    expect(n).toBe(1);
  });

  it("MODEL_COO で主モデルを上書き、preferFallback で退避先から", async () => {
    const calls: string[] = [];
    const ai = { run: async (model: string) => (calls.push(model), okRaw('{"kind":"final","report":"x"}')) };
    const a = AiChatOutput.parse(await (await chatWithAi(ai, [sys("coo_final"), userMsg("x")], {}, { MODEL_COO: "@cf/moonshotai/kimi-k2.6" })).json());
    expect(a.model).toBe("@cf/moonshotai/kimi-k2.6");
    const b = AiChatOutput.parse(await (await chatWithAi(ai, [sys("coo_final"), userMsg("x")], { preferFallback: true })).json());
    expect(b).toMatchObject({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", usedFallback: true });
  });

  it("使用量が返ってこなければ文字数から見積もる", async () => {
    const ai = { run: async () => ({ response: '{"kind":"final","report":"x"}' }) };
    const out = AiChatOutput.parse(await (await chatWithAi(ai, [sys("coo_final"), userMsg("x")])).json());
    expect(out.usage.tokensIn).toBeGreaterThan(0);
    expect(out.usage.tokensOut).toBeGreaterThan(0);
  });
});

describe("normalizeAiResult（ai:probe で取った実物）", () => {
  for (const [name, fixture] of Object.entries({ gptOss120b, gptOss20b, glm, llama, granite })) {
    it(`${name}: { text, usage } にそろう`, () => {
      const raw = (fixture as { raw: { usage: { prompt_tokens: number; completion_tokens: number } } }).raw;
      const n = normalizeAiResult(raw);
      const json = extractFirstJsonObject(n.text);
      expect(json).not.toBeNull();
      expect(CooFinalAction.parse(JSON.parse(json!)).kind).toBe("final");
      expect(n.usage).toEqual({ tokensIn: raw.usage.prompt_tokens, tokensOut: raw.usage.completion_tokens });
    });
  }

  it("他の形（従来形・オブジェクトの response・Responses API・<think>・REST の包み）", () => {
    expect(normalizeAiResult({ response: "abc", usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual({ text: "abc", usage: { tokensIn: 1, tokensOut: 2 } });
    expect(normalizeAiResult({ response: { kind: "final" } }).text).toBe('{"kind":"final"}');
    expect(normalizeAiResult({ response: null, tool_calls: [{ name: "x", arguments: { a: 1 } }] }).text).toBe('{"a":1}');
    expect(
      normalizeAiResult({
        output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "考え中" }] }, { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }],
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    ).toEqual({ text: '{"a":1}', usage: { tokensIn: 5, tokensOut: 6 } });
    expect(normalizeAiResult({ choices: [{ message: { content: '<think>悩む</think>{"a":1}' } }] }).text).toBe('{"a":1}');
    expect(normalizeAiResult({ success: true, result: { response: "x" } }).text).toBe("x");
    expect(normalizeAiResult("plain").text).toBe("plain");
  });

  it("extractFirstJsonObject は文字列の中の括弧を数えない", () => {
    expect(extractFirstJsonObject('前置き {"a":"}{","b":{"c":1}} 後ろ {"d":2}')).toBe('{"a":"}{","b":{"c":1}}');
    expect(extractFirstJsonObject("{壊れ {\"ok\":true}")).toBe('{"ok":true}');
    expect(extractFirstJsonObject("なし")).toBeNull();
  });
});
