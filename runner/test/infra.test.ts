// 補助: 設定、HTTP の BatonApi（再試行と 409）、WebSocket（ヘッダ認証・再接続・イベント）、登録スクリプト。
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpBatonApi } from "../src/api.ts";
import { loadConfig, parseEnvFile } from "../src/config.ts";
import { ConflictError, NetworkError } from "../src/errors.ts";
import { silentLogger } from "../src/log.ts";
import { RunnerSocket, backoffMs, parseRunnerMessage, runnerWsUrl, type WsLike } from "../src/ws.ts";
import { installAgent, renderPlist } from "../scripts/install-agent.ts";
import { buildRegisterSql, parseTailscaleStatus, register } from "../scripts/register.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("設定", () => {
  it("env ファイルと環境変数（環境変数が優先）", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const f = path.join(dir, "runner.env");
    await (await import("node:fs/promises")).writeFile(f, "# c\nBATON_URL=https://x.example/\nBATON_RUNNER_TOKEN='abc'\nBATON_DATA_DIR=~/baton-data\nBATON_LIMIT_MEMBER_TURNS=5\n");
    const c = loadConfig({ BATON_ENV_FILE: f, BATON_URL: "http://localhost:8790", HOME: dir });
    expect(c.batonUrl).toBe("http://localhost:8790");
    expect(c.token).toBe("abc");
    expect(c.dataDir.endsWith("baton-data")).toBe(true);
    expect(c.limits.memberTurns).toBe(5);
    expect(c.localPort).toBe(7777);
    expect(c.localAuth).toBe(true);
    expect(c.allowedOrigins).toEqual(["https://baton.rikuhiromatsu.workers.dev", "http://localhost:8790"]);
    expect(() => loadConfig({})).toThrow(/BATON_URL/);
    expect(parseEnvFile("export A=1\nB=\"2\"")).toEqual({ A: "1", B: "2" });
  });
});

describe("HttpBatonApi", () => {
  async function server(handler: http.RequestListener) {
    const s = http.createServer(handler);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it("5xx は 1→4→15 秒（テストでは 0）で 3 回まで再試行、409 は即 ConflictError、204 の claim は null", async () => {
    let n = 0;
    const url = await server((req, res) => {
      n++;
      if (req.url === "/api/runner/heartbeat") {
        res.writeHead(n < 3 ? 503 : 200, { "content-type": "application/json" });
        res.end(n < 3 ? '{"error":{"code":"internal","message":"x"}}' : JSON.stringify({ serverTime: 1, cancelInstructionIds: [] }));
      } else if (req.url === "/api/runner/claim") {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(409, { "content-type": "application/json" });
        res.end('{"error":{"code":"conflict","message":"not leased"}}');
      }
    });
    const api = new HttpBatonApi({ baseUrl: url, token: "t", retryDelaysMs: [0, 0, 0] });
    expect(await api.heartbeat({ version: "1", tailnetUrl: null, activeInstructionIds: [], maxConcurrent: 2 })).toEqual({ serverTime: 1, cancelInstructionIds: [] });
    expect(n).toBe(3);
    expect(await api.claim({ maxConcurrent: 2, activeIds: [] })).toBeNull();
    const before = n;
    await expect(api.release("00000000-0000-4000-8000-000000000000", { reason: "shutdown", notBefore: null })).rejects.toBeInstanceOf(ConflictError);
    expect(n - before).toBe(1);
  });

  it("届かなければ NetworkError（再試行のあと）", async () => {
    const api = new HttpBatonApi({ baseUrl: "http://127.0.0.1:1", token: "t", retryDelaysMs: [0] });
    await expect(api.claim({ maxConcurrent: 2, activeIds: [] })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("WebSocket", () => {
  it("URL・再接続の間隔・メッセージの解釈", () => {
    expect(runnerWsUrl("https://baton.rikuhiromatsu.workers.dev")).toBe("wss://baton.rikuhiromatsu.workers.dev/api/runner/ws");
    expect(runnerWsUrl("http://localhost:8790")).toBe("ws://localhost:8790/api/runner/ws");
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffMs(a))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(parseRunnerMessage('{"t":"work.available"}')).toEqual([{ t: "work.available" }]);
    expect(parseRunnerMessage('{"t":"batch","items":[{"t":"instruction.cancel","instructionId":"a"},{"t":"bogus"}]}')).toEqual([{ t: "instruction.cancel", instructionId: "a" }]);
    expect(parseRunnerMessage("pong")).toEqual([]);
    expect(parseRunnerMessage("{bad")).toEqual([]);
  });

  it("Bearer ヘッダで接続し、切れたら再接続、イベントを渡す", async () => {
    const made: { url: string; headers: Record<string, string>; ws: WsLike }[] = [];
    const events: unknown[] = [];
    const sock = new RunnerSocket({
      batonUrl: "http://localhost:8790",
      token: "tok",
      log: silentLogger,
      onEvent: (e) => events.push(e),
      factory: (url, headers) => {
        const ws: WsLike = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
        made.push({ url, headers, ws });
        return ws;
      },
    });
    sock.start();
    expect(made[0]).toMatchObject({ url: "ws://localhost:8790/api/runner/ws", headers: { authorization: "Bearer tok" } });
    made[0]!.ws.onopen?.({});
    made[0]!.ws.onmessage?.({ data: '{"t":"decision.answered","instructionId":"x"}' });
    expect(events).toEqual([{ t: "work.available" }, { t: "decision.answered", instructionId: "x" }]);
    made[0]!.ws.onclose?.({ code: 1006 });
    await new Promise((r) => setTimeout(r, 1100));
    expect(made).toHaveLength(2);
    sock.close();
  });

  it("Node 26 の WebSocket は Authorization ヘッダを送れる", async () => {
    const got = new Promise<string | undefined>((resolve) => {
      const s = http.createServer();
      s.on("upgrade", (req, socket) => {
        resolve(req.headers.authorization);
        socket.destroy();
        s.close();
      });
      s.listen(0, "127.0.0.1", () => {
        const ws = new WebSocket(`ws://127.0.0.1:${(s.address() as AddressInfo).port}/api/runner/ws`, { headers: { authorization: "Bearer abc" } });
        ws.onerror = () => {};
      });
    });
    expect(await got).toBe("Bearer abc");
  });
});

describe("登録スクリプトと launchd", () => {
  it("register --dry-run は書き込みも wrangler もせず、トークンを表示しない", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const out: string[] = [];
    const ran: string[][] = [];
    const envFile = path.join(dir, "cfg/runner.env");
    const deps = {
      now: () => 1,
      token: () => "TOKEN-SHOULD-NOT-APPEAR",
      id: () => "11111111-1111-4111-8111-111111111111",
      runWrangler: (a: string[]) => void ran.push(a),
      tailscale: () => ({ login: "riku@github", url: "https://rikumac-mini.tail6eb659.ts.net" }),
      out: (l: string) => void out.push(l),
    };
    await register(["--dry-run", "--env-file", envFile, "--name", "rikumac-mini"], deps);
    expect(ran).toHaveLength(0);
    await expect(stat(envFile)).rejects.toThrow();
    expect(out.join("\n")).not.toContain("TOKEN-SHOULD-NOT-APPEAR");

    // 本実行: wrangler に SQL（ハッシュ）を渡し、600 で env を書く。トークンは出力に出ない
    await register(["--env-file", envFile, "--name", "rikumac-mini"], deps);
    expect(ran[0]?.slice(0, 5)).toEqual(["d1", "execute", "baton", "--remote", "--command"]);
    expect(ran[0]?.[5]).toMatch(/UPDATE runners SET revoked = 1 WHERE name = 'rikumac-mini'.*INSERT INTO runners/);
    expect(ran[0]?.[5]).not.toContain("TOKEN-SHOULD-NOT-APPEAR");
    const st = await stat(envFile);
    expect(st.mode & 0o777).toBe(0o600);
    const env = parseEnvFile(await readFile(envFile, "utf8"));
    expect(env).toMatchObject({ BATON_RUNNER_TOKEN: "TOKEN-SHOULD-NOT-APPEAR", BATON_RUNNER_NAME: "rikumac-mini", ALLOWED_TAILNET_LOGINS: "riku@github", BATON_LOCAL_PORT: "7777" });
    expect(out.join("\n")).not.toContain("TOKEN-SHOULD-NOT-APPEAR");
  });

  it("SQL・tailscale の解釈", () => {
    expect(() => buildRegisterSql({ id: "x'; DROP", name: "a", tokenHash: "0".repeat(64), now: 1 })).toThrow();
    expect(buildRegisterSql({ id: "11111111-1111-4111-8111-111111111111", name: "Rikumac Mini.local", tokenHash: "a".repeat(64), now: 5 })).toContain("'rikumac-mini'");
    expect(parseTailscaleStatus(JSON.stringify({ Self: { UserID: 7, DNSName: "rikumac-mini.tail6eb659.ts.net." }, User: { "7": { LoginName: "riku@github" } } }))).toEqual({
      login: "riku@github",
      url: "https://rikumac-mini.tail6eb659.ts.net",
    });
  });

  it("install-agent --dry-run は plist を作るだけで書き込みも launchctl もしない", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const calls: string[][] = [];
    const r = await installAgent(["--dry-run", "--home", dir, "--repo", "/repo"], { uid: () => 501, launchctl: (a) => void calls.push(a), out: () => {} });
    expect(calls).toHaveLength(0);
    await expect(stat(r.plistPath)).rejects.toThrow();
    expect(r.plist).toContain("<string>/repo/runner/src/main.ts</string>");
    expect(r.plist).toContain(`<string>${dir}/.config/baton/runner.env</string>`);
    expect(r.plist).not.toMatch(/\{\{/);
    const r2 = await installAgent(["--home", dir, "--repo", "/repo"], { uid: () => 501, launchctl: (a) => void calls.push(a), out: () => {} });
    expect(calls).toEqual([
      ["bootout", "gui/501/com.rikuhiromatsu.baton-runner"],
      ["bootstrap", "gui/501", r2.plistPath],
    ]);
    expect(() => renderPlist("{{OTHER}}", { repo: "/", home: "/" })).toThrow();
  });
});
