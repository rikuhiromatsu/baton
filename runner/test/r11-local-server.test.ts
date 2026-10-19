// R11 tailnet HTTP: Tailscale-User-Login 無し・許可外は 403、/files のパス脱出を拒否、CORS ヘッダ。
import { mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalServer, listenLocal } from "../src/local-server.ts";
import { LiveLog, silentLogger } from "../src/log.ts";
import { tempDir, testConfig } from "./helpers.ts";

const LOGIN = "riku@example.com";

/** fetch は Host 等を勝手に整えるので、パスをそのまま送れる http.request を使う */
function get(port: number, p: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
        if (res.headers["content-type"]?.startsWith("text/event-stream") && body.includes("\n\n")) {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          req.destroy();
        }
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("R11 tailnet 向けのローカル HTTP", () => {
  let server: http.Server;
  let port: number;
  let cleanup: () => Promise<void>;
  let liveLog: LiveLog;
  let dir: string;

  const start = async (env: Record<string, string> = {}) => {
    const config = testConfig(dir, {}, { ALLOWED_TAILNET_LOGINS: LOGIN, ...env });
    liveLog = new LiveLog();
    server = createLocalServer({
      config,
      liveLog,
      log: silentLogger,
      stats: { lastAiError: { at: 1, instructionId: "i", message: "503" } },
      status: () => ({ activeInstructionIds: ["abc"], maxConcurrent: 2, lastHeartbeatAt: 5, hubConnected: true }),
    });
    port = await listenLocal(server, 0);
  };

  beforeEach(async () => {
    const t = await tempDir();
    dir = t.dir;
    cleanup = t.cleanup;
    await mkdir(path.join(dir, "projects/demo/docs"), { recursive: true });
    await writeFile(path.join(dir, "projects/demo/docs/report.md"), "# 報告\n本文");
    await writeFile(path.join(dir, "projects/demo/.secret"), "x");
    await writeFile(path.join(dir, "outside.txt"), "outside");
    await symlink(path.join(dir, "outside.txt"), path.join(dir, "projects/demo/link.txt"));
  });
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    await cleanup();
  });

  it("127.0.0.1 だけで待ち受ける", async () => {
    await start();
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");
  });

  it("Tailscale-User-Login が無い・許可外なら 403", async () => {
    await start();
    expect((await get(port, "/status")).status).toBe(403);
    expect((await get(port, "/status", { "tailscale-user-login": "other@example.com" })).status).toBe(403);
    expect((await get(port, "/files/demo/docs/report.md")).status).toBe(403);
    expect((await get(port, "/logs/abc/stream")).status).toBe(403);
    const ok = await get(port, "/status", { "tailscale-user-login": LOGIN.toUpperCase() });
    expect(ok.status).toBe(200);
    const s = JSON.parse(ok.body);
    expect(s).toMatchObject({ name: "test-runner", activeInstructionIds: ["abc"], maxConcurrent: 2, lastAiError: { message: "503" } });
    expect(typeof s.uptimeMs).toBe("number");
  });

  it("BATON_LOCAL_AUTH=off のときだけ検査を省く", async () => {
    await start({ BATON_LOCAL_AUTH: "off" });
    expect((await get(port, "/status")).status).toBe(200);
  });

  it("/files のパス脱出を拒否する", async () => {
    await start();
    const h = { "tailscale-user-login": LOGIN };
    for (const p of [
      "/files/demo/..%2F..%2Foutside.txt",
      "/files/demo/%2E%2E/%2E%2E/outside.txt",
      "/files/demo/docs%2F..%2F..%2F..%2Foutside.txt",
      "/files/demo/link.txt",
      "/files/demo/.baton/history/x",
      "/files/demo/%2Fetc%2Fpasswd",
    ]) {
      const r = await get(port, p, h);
      expect([403, 404], p).toContain(r.status);
      expect(r.body).not.toContain("outside");
    }
    expect((await get(port, "/files/..%2F/x", h)).status).toBe(404);
    expect((await get(port, "/files/nope/x", h)).status).toBe(404);
  });

  it("ファイル本体は inline で返し、一覧は JSON（隠しファイルを出さない）", async () => {
    await start();
    const h = { "tailscale-user-login": LOGIN };
    const f = await get(port, "/files/demo/docs/report.md", h);
    expect(f.status).toBe(200);
    expect(f.body).toBe("# 報告\n本文");
    expect(f.headers["content-disposition"]).toMatch(/^inline/);
    expect(f.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(f.headers["content-security-policy"]).toMatch(/sandbox/);
    const l = await get(port, "/files/demo/", h);
    expect(l.status).toBe(200);
    const list = JSON.parse(l.body);
    expect(list.entries.map((e: { path: string }) => e.path)).toEqual(["docs/", "docs/report.md"]);
  });

  it("CORS は許可したオリジンの GET だけ", async () => {
    await start();
    const h = { "tailscale-user-login": LOGIN };
    const allowed = await get(port, "/status", { ...h, origin: "https://baton.rikuhiromatsu.workers.dev" });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://baton.rikuhiromatsu.workers.dev");
    expect(allowed.headers["access-control-allow-methods"]).toBe("GET");
    const local = await get(port, "/status", { ...h, origin: "http://localhost:8790" });
    expect(local.headers["access-control-allow-origin"]).toBe("http://localhost:8790");
    const evil = await get(port, "/status", { ...h, origin: "https://evil.example" });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await get(port, "/status", { origin: "http://localhost:8790", "access-control-request-method": "GET", "access-control-request-private-network": "true" }, "OPTIONS");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-private-network"]).toBe("true");
    const preEvil = await get(port, "/status", { origin: "https://evil.example" }, "OPTIONS");
    expect(preEvil.status).toBe(403);
    expect((await get(port, "/status", h, "POST")).status).toBe(405);
  });

  it("BATON_ALLOWED_ORIGINS で許可オリジンを変えられる", async () => {
    await start({ BATON_ALLOWED_ORIGINS: "http://localhost:9999" });
    const r = await get(port, "/status", { "tailscale-user-login": LOGIN, origin: "http://localhost:8790" });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("/logs/:id/stream は SSE でこれまでのログと新しいログを流す", async () => {
    await start();
    liveLog.append("inst-1", "note", { message: "前のログ" });
    const r = await get(port, "/logs/inst-1/stream", { "tailscale-user-login": LOGIN });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(r.body).toMatch(/^data: .*前のログ/);
  });
});
