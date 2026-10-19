// R12 SIGTERM で release してから終了。
// 本物のプロセス（node src/main.ts）を、偽の Worker（HTTP サーバー）に向けて起動して確かめる。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

const RUNNER_DIR = path.resolve(import.meta.dirname, "..");

function fakeWorker(instructionId: string) {
  const seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];
  let claimed = false;
  let aiStarted: () => void = () => {};
  const aiStartedP = new Promise<void>((r) => (aiStarted = r));
  const now = Date.now();
  const summary = {
    id: instructionId,
    clientId: randomUUID(),
    body: "長くかかる指示",
    title: null,
    status: "running",
    statusChangedAt: now,
    projectId: null,
    projectName: null,
    resultSummary: null,
    openDecisionId: null,
    notBefore: null,
    error: null,
    taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    feedback: null,
    attempt: 1,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body });
      const json = (status: number, o: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? "";
      if (url === "/api/runner/heartbeat") return json(200, { serverTime: Date.now(), cancelInstructionIds: [] });
      if (url === "/api/runner/claim") {
        if (claimed) {
          res.writeHead(204);
          return res.end();
        }
        claimed = true;
        return json(200, { instruction: summary, resume: false });
      }
      if (url === `/api/runner/instructions/${instructionId}/state`) {
        return json(200, {
          instruction: summary,
          project: null,
          coo: { id: "agent-coo", projectId: null, role: "coo", name: "COO", specialty: "", model: null, active: true },
          tasks: [],
          decisions: [],
          routed: false,
          nextEventSeq: 0,
        });
      }
      if (url === "/api/runner/events") return json(200, { lastSeq: 0 });
      if (url === "/api/runner/ai/chat") {
        aiStarted();
        return; // 返さない（実行中のまま）
      }
      if (url === `/api/runner/instructions/${instructionId}/release`) {
        res.writeHead(204);
        return res.end();
      }
      json(404, { error: { code: "not_found", message: "not found" } });
    });
  });
  return { server, seen, aiStartedP };
}

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

describe("R12 停止", () => {
  it("SIGTERM を受けたら実行中の指示を release { reason: shutdown } してから 5 秒以内に終了する", async () => {
    const id = randomUUID();
    const w = fakeWorker(id);
    await new Promise<void>((r) => w.server.listen(0, "127.0.0.1", r));
    cleanups.push(() => {
      w.server.closeAllConnections();
      return new Promise<void>((r) => w.server.close(() => r()));
    });
    const port = (w.server.address() as AddressInfo).port;
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      BATON_URL: `http://127.0.0.1:${port}`,
      BATON_RUNNER_TOKEN: "secret-token",
      BATON_DATA_DIR: dir,
      BATON_LOCAL_PORT: "0",
      BATON_RUNNER_NAME: "r12",
    };
    const child = spawn(process.execPath, ["src/main.ts"], { cwd: RUNNER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });

    await Promise.race([w.aiStartedP, new Promise((_, rej) => setTimeout(() => rej(new Error(`AI 呼び出しまで進まない:\n${out}`)), 10_000))]);
    const exited = new Promise<{ code: number | null; ms: number }>((resolve) => {
      const t0 = Date.now();
      child.on("exit", (code) => resolve({ code, ms: Date.now() - t0 }));
    });
    child.kill("SIGTERM");
    const { code, ms } = await exited;

    expect(code).toBe(0);
    expect(ms).toBeLessThan(5000);
    const release = w.seen.find((s) => s.path === `/api/runner/instructions/${id}/release`);
    expect(release?.body).toEqual({ reason: "shutdown", notBefore: null });
    // Bearer で認証し、トークンをログに出さない
    expect(w.seen.every((s) => s.auth === "Bearer secret-token")).toBe(true);
    expect(out).not.toContain("secret-token");
    expect(out).toContain("停止しました");
  });
});
