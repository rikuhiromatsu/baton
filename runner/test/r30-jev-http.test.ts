// R30 Jev の HTTP クライアント（5.9.1）: テストの中の小さな HTTP サーバーに BATON_TYPESAFE_BASE_URL を向ける。TypeSafe は呼ばない。
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { childEnv } from "../src/claude/env.ts";
import { HttpJevClient } from "../src/claude/jev.ts";
import { buildJevState } from "../src/claude/jev-policy.ts";
import type { Logger } from "../src/log.ts";
import { makeEnv, type Env } from "./helpers.ts";

const KEY = "tsk-test-KEY-9f8e7d6c5b4a3210-not-a-real-key";

type Seen = { method: string; url: string; auth: string | undefined; contentType: string | undefined; body: string };
type Reply = { status?: number; body?: string; delayMs?: number };
const GOOD = JSON.stringify({ answers: { tier: { choice: "fast", confidence: 0.87 }, effort: { score: 0, confidence: 0.8 }, risky: { noul: 0.04 } } });

async function fakeTypeSafe(reply: () => Reply = () => ({ body: GOOD })) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") });
      const r = reply();
      setTimeout(() => {
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(r.body ?? GOOD);
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, url, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const state = buildJevState({ title: "メモを書く", spec: "hello.txt に 1 行書く", paths: ["hello.txt"], profileId: "generalist", workspaceKind: "baton", round: 1, conflictResolution: false, dependsOn: 0, maxTurns: 80 }) as unknown as Record<string, unknown>;

let closers: (() => Promise<void>)[] = [];
let env: Env | undefined;
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
  await env?.cleanup();
  env = undefined;
});

const client = (url: string, over: Partial<ConstructorParameters<typeof HttpJevClient>[0]> = {}) =>
  new HttpJevClient({ baseUrl: url, model: "jev-latest", timeoutMs: 1500, envKey: KEY, home: "/nonexistent-home", ...over });

describe("R30 HTTP の形", () => {
  it("POST /v1/systemone・Bearer・本文 { model, state, questions: { tier, effort, risky(noul) } }。answers を Decision に読む", async () => {
    const srv = await fakeTypeSafe();
    closers.push(srv.close);
    const r = await client(srv.url).decide(state);
    expect(r.error).toBeNull();
    expect(r.decision).toEqual({ tier: "fast", confidence: 0.87, effort: 0, effortConfidence: 0.8, risky: 0.04 });
    expect(srv.seen).toHaveLength(1);
    const s = srv.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/v1/systemone");
    expect(s.auth).toBe(`Bearer ${KEY}`);
    expect(s.contentType).toContain("application/json");
    const body = JSON.parse(s.body) as { model: string; state: unknown; questions: Record<string, { type: string }> };
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual(state);
    expect(Object.keys(body.questions)).toEqual(["tier", "effort", "risky"]);
    expect(body.questions.tier!.type).toBe("choice");
    expect(body.questions.effort!.type).toBe("score");
    expect(body.questions.risky!.type).toBe("noul");
    // 末尾の / があっても同じ
    const r2 = await client(`${srv.url}/`).decide(state);
    expect(r2.decision?.tier).toBe("fast");
  });

  it("時間切れ・500・壊れた JSON・tier 無し・つながらない → decision: null と短い理由", async () => {
    let next: Reply = {};
    const srv = await fakeTypeSafe(() => next);
    closers.push(srv.close);
    next = { delayMs: 300 };
    const t = await client(srv.url, { timeoutMs: 100 }).decide(state);
    expect(t).toMatchObject({ decision: null, error: "timeout" });
    expect(t.ms).toBeLessThan(290);
    next = { status: 500, body: "boom sensitive body" };
    expect(await client(srv.url).decide(state)).toMatchObject({ decision: null, error: "http 500" });
    next = { body: "{not json" };
    expect(await client(srv.url).decide(state)).toMatchObject({ decision: null, error: "bad_body" });
    next = { body: JSON.stringify({ answers: { effort: { score: 1 } } }) };
    expect(await client(srv.url).decide(state)).toMatchObject({ decision: null, error: "bad_body" });
    const dead = await client("http://127.0.0.1:9").decide(state);
    expect(dead.decision).toBeNull();
    expect(dead.error).toBeTruthy();
    expect(JSON.stringify(dead)).not.toContain(KEY);
  });

  it("鍵が無いとリクエストを出さない（no_key）", async () => {
    const srv = await fakeTypeSafe();
    closers.push(srv.close);
    const r = await client(srv.url, { envKey: null }).decide(state);
    expect(r).toMatchObject({ decision: null, error: "no_key" });
    expect(srv.seen).toHaveLength(0);
  });
});

describe("R30 鍵はどこにも出ない", () => {
  it("ログ・D1（偽 Worker）・トランスクリプト・claude の引数・/status・子の環境に鍵の文字列が無い（成功と失敗の両方）", async () => {
    const lines: string[] = [];
    const collect = (level: string) => (msg: string, data?: Record<string, unknown>) => void lines.push(JSON.stringify({ level, msg, ...data }));
    const log: Logger = { debug: collect("debug"), info: collect("info"), warn: collect("warn"), error: collect("error") };
    let mode: "ok" | "bad" = "ok";
    const srv = await fakeTypeSafe(() => (mode === "ok" ? { body: GOOD } : { status: 503, body: `echo ${KEY}` }));
    closers.push(srv.close);
    const base = { BATON_JEV_ROUTING: "on", BATON_TYPESAFE_BASE_URL: srv.url, BATON_TYPESAFE_API_KEY: KEY, BATON_JEV_TIMEOUT_MS: "1500" };
    env = await makeEnv({ log, env: base });
    const home = env.config.home;
    // エンジニアを haiku まで下げてよいことにする（判定が通る様子を見る）
    await mkdir(env.config.profilesLocalPath.replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(env.config.profilesLocalPath, JSON.stringify({ profiles: { engineer: { jev: { min: "haiku", max: "opus" } } } }));
    env.api.ceoSays(COO_THREAD_ID, "メモを書いて");
    await env.drain();
    expect(srv.seen.length).toBeGreaterThanOrEqual(1);
    expect(srv.seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
    // 失敗側
    mode = "bad";
    env.api.ceoSays(COO_THREAD_ID, "別のメモを書いて");
    await env.drain();
    expect(lines.some((l) => l.includes("Jev に聞けませんでした") && l.includes("http 503"))).toBe(true);
    expect(lines.some((l) => l.includes("Jev の判定"))).toBe(true);

    const haystacks = [
      lines.join("\n"),
      JSON.stringify([...env.api.sessions.values()]),
      JSON.stringify(env.api.transcript),
      JSON.stringify([...env.api.messages.values()]),
      JSON.stringify(env.ctx.jev.status()),
      JSON.stringify(env.ctx.liveLog),
    ];
    for (const h of haystacks) expect(h).not.toContain(KEY);
    // 子の環境（R1' と同じ検査）
    const child = childEnv({ home, passthrough: { ...process.env, BATON_TYPESAFE_API_KEY: KEY, FAKE_X: "1" } });
    expect(JSON.stringify(child)).not.toContain(KEY);
    expect(Object.keys(child)).not.toContain("BATON_TYPESAFE_API_KEY");
  }, 60_000);
});
