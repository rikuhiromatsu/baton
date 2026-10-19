#!/usr/bin/env node
// npm run ai:probe -w app
// 設計書 2.2 のモデルに 1 回ずつ同じ短い依頼（JSON を返させる）を投げ、生の戻り値を
// app/test/fixtures/ai/<model>.json に保存する。normalizeAiResult() のテストがこれを使う。
//
// wrangler の OAuth には ai スコープが無いため、REST API ではなく
// 「ai バインディング（remote: true）だけを持つ使い捨ての Worker を wrangler dev で動かす」方法で呼ぶ。
// remote バインディングは workers_scripts の権限で動くので、追加のトークンは要らない。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const outDir = path.join(appDir, "test", "fixtures", "ai");
const port = Number(process.env.AI_PROBE_PORT ?? 8799); // 8790 は E2E 用なので使わない
const wrangler = path.resolve(appDir, "..", "node_modules", ".bin", "wrangler");

const MODELS = [
  "@cf/openai/gpt-oss-120b",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/openai/gpt-oss-20b",
  "@cf/ibm-granite/granite-4.0-h-micro",
];

const SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: ["final"] }, report: { type: "string" } },
  required: ["kind", "report"],
  additionalProperties: false,
};

const INPUT = {
  messages: [
    { role: "system", content: "ROLE: coo_final\nあなたは COO です。JSON オブジェクトを 1 つだけ返してください。前後に文章を書かないでください。" },
    { role: "user", content: '<<<input>>>\n「おはよう」と一言だけ報告して\n<<<end>>>\n出力形式: {"kind":"final","report":"..."}' },
  ],
  response_format: { type: "json_schema", json_schema: { name: "coo_final", schema: SCHEMA } },
  max_completion_tokens: 512,
};

const WORKER = `export default {
  async fetch(req, env) {
    const model = new URL(req.url).searchParams.get("model");
    const input = await req.json();
    const started = Date.now();
    try {
      const raw = await env.AI.run(model, input);
      return Response.json({ ok: true, raw, ms: Date.now() - started });
    } catch (e) {
      return Response.json({ ok: false, error: String((e && e.message) || e), ms: Date.now() - started });
    }
  },
};`;

function fileName(model) {
  return `${model.replace(/^@cf\//, "").replaceAll("/", "__")}.json`;
}

async function waitReady(child, logs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${logs.join("")}`)), 90_000);
    const onData = (d) => {
      logs.push(String(d));
      if (/Ready on/.test(String(d))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`wrangler dev exited (${code}):\n${logs.join("")}`)));
  });
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "baton-ai-probe-"));
  writeFileSync(path.join(dir, "worker.js"), WORKER);
  writeFileSync(
    path.join(dir, "wrangler.json"),
    JSON.stringify({ name: "baton-ai-probe", main: "worker.js", compatibility_date: "2026-10-01", ai: { binding: "AI", remote: true } }),
  );
  const logs = [];
  const child = spawn(wrangler, ["dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: dir, env: process.env });
  try {
    await waitReady(child, logs);
    mkdirSync(outDir, { recursive: true });
    for (const model of MODELS) {
      const attempts = [];
      for (const input of [INPUT, { ...INPUT, response_format: undefined }]) {
        const res = await fetch(`http://127.0.0.1:${port}/?model=${encodeURIComponent(model)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = await res.json();
        attempts.push({ withResponseFormat: input.response_format !== undefined, ...body });
        if (body.ok) break; // response_format を拒否されたときだけ、付けずにもう 1 回
      }
      const last = attempts[attempts.length - 1];
      const fixture = {
        source: "real",
        note: "npm run ai:probe（wrangler dev の remote AI バインディング）で取得した Workers AI の生の戻り値",
        model,
        probedAt: new Date().toISOString(),
        input: INPUT,
        attempts,
        raw: last.ok ? last.raw : null,
      };
      writeFileSync(path.join(outDir, fileName(model)), `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`${model}: ${attempts.map((a) => (a.ok ? "ok" : `error(${a.error})`)).join(" → ")}`);
    }
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
