// R32 Jev の鍵の読み方（5.9.1・D-134）: BATON_TYPESAFE_API_KEY ＞ settings.json の jev-model-router@skills-dir ＞ jev-model-router。
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpJevClient } from "../src/claude/jev.ts";
import { createLocalServer, listenLocal } from "../src/local-server.ts";
import { LiveLog, silentLogger } from "../src/log.ts";
import { makeEnv, tempDir, testConfig } from "./helpers.ts";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function home() {
  const t = await tempDir("baton-jev-key-");
  cleanups.push(t.cleanup);
  await mkdir(path.join(t.dir, ".claude"), { recursive: true });
  return { dir: t.dir, settings: path.join(t.dir, ".claude/settings.json") };
}
const mk = (dir: string, envKey: string | null = null) => new HttpJevClient({ baseUrl: "http://127.0.0.1:9", model: "jev-latest", timeoutMs: 50, envKey, home: dir });

describe("R32 鍵の出どころ", () => {
  it("env ＞ settings（@skills-dir）＞ settings（jev-model-router）＞ none", async () => {
    const h = await home();
    expect(mk(h.dir).status().keySource).toBe("none"); // settings.json が無い
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: { "jev-model-router": { options: { typesafeApiKey: "from-plain" } } } }));
    expect(mk(h.dir).status().keySource).toBe("settings");
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: { "jev-model-router@skills-dir": { options: { typesafeApiKey: "from-dir" } }, "jev-model-router": { options: { typesafeApiKey: "from-plain" } } } }));
    expect(mk(h.dir).status().keySource).toBe("settings");
    expect(mk(h.dir, "from-env").status().keySource).toBe("env");
    expect(mk(h.dir, "  ").status().keySource).toBe("settings");
  });

  it("どのキーが使われたかは問い合わせの Bearer で分かる（@skills-dir が先）", async () => {
    const http = await import("node:http");
    const auths: string[] = [];
    const server = http.createServer((req, res) => {
      auths.push(String(req.headers.authorization));
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;
    const h = await home();
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: { "jev-model-router@skills-dir": { options: { typesafeApiKey: "from-dir" } }, "jev-model-router": { options: { typesafeApiKey: "from-plain" } } } }));
    const c = new HttpJevClient({ baseUrl: `http://127.0.0.1:${port}`, model: "m", timeoutMs: 1000, envKey: null, home: h.dir });
    await c.decide({});
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: { "jev-model-router": { options: { typesafeApiKey: "from-plain" } } } }));
    const later = new Date(Date.now() + 5000);
    await utimes(h.settings, later, later);
    await c.decide({});
    expect(auths).toEqual(["Bearer from-dir", "Bearer from-plain"]);
  });

  it("settings.json が壊れている・鍵が空・型が違う → none（落ちない）", async () => {
    const h = await home();
    await writeFile(h.settings, "{ここは壊れた JSON");
    expect(mk(h.dir).status().keySource).toBe("none");
    for (const bad of [
      { pluginConfigs: { "jev-model-router@skills-dir": { options: { typesafeApiKey: "" } } } },
      { pluginConfigs: { "jev-model-router@skills-dir": { options: { typesafeApiKey: 123 } } } },
      { pluginConfigs: "x" },
      [],
      null,
    ]) {
      await writeFile(h.settings, JSON.stringify(bad));
      expect(mk(h.dir).status().keySource).toBe("none");
    }
    const r = await mk(h.dir).decide({});
    expect(r).toMatchObject({ decision: null, error: "no_key" });
  });

  it("mtime が変わると読み直す", async () => {
    const h = await home();
    const c = mk(h.dir);
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: {} }));
    expect(c.status().keySource).toBe("none");
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: { "jev-model-router": { options: { typesafeApiKey: "k" } } } }));
    const later = new Date(Date.now() + 10_000);
    await utimes(h.settings, later, later);
    expect(c.status().keySource).toBe("settings");
    await writeFile(h.settings, JSON.stringify({ pluginConfigs: {} }));
    const later2 = new Date(Date.now() + 20_000);
    await utimes(h.settings, later2, later2);
    expect(c.status().keySource).toBe("none");
  });

  it("/status の jev は出どころだけ（鍵そのものは出ない）", async () => {
    const secret = "tsk-status-secret-0123456789abcdef-zzz";
    const env = await makeEnv({ env: { BATON_JEV_ROUTING: "shadow", BATON_TYPESAFE_API_KEY: secret } });
    cleanups.push(env.cleanup);
    const server = createLocalServer({
      config: { ...testConfig(env.dataDir), localAuth: false },
      liveLog: new LiveLog(),
      log: silentLogger,
      status: () => ({
        activeInstructionIds: [],
        activeThreadIds: [],
        activeSessionIds: [],
        lastHeartbeatAt: null,
        hubConnected: true,
        claudeAuth: "ok",
        claudeVersion: null,
        quota: null,
        authStop: null,
        jev: { mode: env.config.jev.routing, ...env.ctx.jev.status() },
      }),
    });
    const port = await listenLocal(server, 0);
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
    const text = await (await fetch(`http://127.0.0.1:${port}/status`)).text();
    expect(JSON.parse(text).jev).toEqual({ mode: "shadow", keySource: "env", lastAt: null, lastError: null });
    expect(text).not.toContain(secret);
  });
});
