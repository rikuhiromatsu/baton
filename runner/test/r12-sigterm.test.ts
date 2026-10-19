// R12 停止（5.7）: SIGTERM で全プロセスに interrupt → lease を外す（release shutdown）→ 5 秒以内に終了。claude の子も残らない。
// あわせて、起動したランナーのハートビートに v2 の項目（枠・claude の版と認証・プロファイル・動いているセッション）が載ること。
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { FakeBatonApi } from "./fakes/fake-api.ts";
import { serveFakeApi } from "./fakes/http-adapter.ts";
import { FAKE_CLAUDE, REPO_ROOT, makeHome, tempDir, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("R12 停止", () => {
  it("SIGTERM: ターン中の claude に interrupt、release(shutdown)、5 秒以内に終了し、子プロセスも残らない", async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const home = await makeHome(t.dir);
    const api = new FakeBatonApi();
    const srv = await serveFakeApi(api);
    cleanups.push(srv.close);
    api.ceoSays(COO_THREAD_ID, "[slow] [long] 長い返事をして");
    const child = spawn(process.execPath, ["runner/src/main.ts"], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        BATON_URL: srv.url,
        BATON_RUNNER_TOKEN: "t",
        BATON_DATA_DIR: path.join(t.dir, "data"),
        BATON_HOME: home,
        BATON_PROJECTS_ROOT: path.join(home, "projects"),
        BATON_LOCAL_PORT: "0",
        BATON_CLAUDE_BIN: FAKE_CLAUDE,
        BATON_CODEX_REVIEW: "off",
        FAKE_CLAUDE_STATE_DIR: path.join(t.dir, "fake"),
        FAKE_CLAUDE_SLOW_MS: "2000",
        BATON_LOG_LEVEL: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    cleanups.push(() => void child.kill("SIGKILL"));
    await waitFor(() => api.sessions.size > 0 && api.heartbeats.length > 0 && api.messagesOf(COO_THREAD_ID).some((m) => m.status === "streaming"), 15_000);
    const hb = api.heartbeats[0]!;
    expect(hb.claudeAuth).toBe("ok");
    expect(hb.profiles.map((p) => p.id)).toEqual(expect.arrayContaining(["coo", "leader", "researcher"]));
    expect(hb.quota).toHaveProperty("fiveHour");
    // 子の claude
    const kids = execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
    expect(kids.length).toBeGreaterThan(0);
    const started = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(Date.now() - started).toBeLessThan(5500);
    expect(code).toBe(0);
    expect(api.releases).toContainEqual({ kind: "thread", id: COO_THREAD_ID, reason: "shutdown", notBefore: null });
    await waitFor(() => kids.every((k) => !alive(k)), 3000);
    expect(out).not.toMatch(/想定外/);
  }, 40_000);
});
