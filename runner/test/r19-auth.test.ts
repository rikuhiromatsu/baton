// R19 認証（7.7・D-48）: init の apiKeySource が none でない（[apikey]）か MCP が読み込まれた（[mcpleak]）ら即停止し、以後の起動を止める。
// claude auth status の読み取り。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { checkClaudeAuth, parseAuthStatus } from "../src/startup.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R19 認証の守り", () => {
  for (const marker of ["apikey", "mcpleak"]) {
    it(`[${marker}] で即停止・release(auth)・以後のターンもメンバーも起動しない`, async () => {
      env = await makeEnv();
      env.api.ceoSays(COO_THREAD_ID, `[${marker}] こんにちは`);
      const r = await env.step();
      expect(r?.outcome).toBe("failed");
      expect(env.ctx.auth.tripped).toMatch(marker === "apikey" ? /サブスク以外の認証/ : /MCP/);
      expect(env.api.releases.at(-1)).toMatchObject({ kind: "thread", reason: "auth" });
      expect(env.api.sessions.get(env.api.releases.length ? [...env.api.sessions.keys()][0]! : "")!.status).toBe("failed");
      // 次のターンは起動せずに返す
      env.api.ceoSays(COO_THREAD_ID, "もう一度");
      env.api.threads.get(COO_THREAD_ID)!.leased = false;
      const r2 = await env.step();
      expect(r2?.outcome).toBe("released");
      expect(env.api.sessions.size).toBe(1);
    }, 30_000);
  }

  it("claude auth status: サブスクのログインだけ ok", async () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }))).toBe("ok");
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false }))).toBe("not_logged_in");
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" }))).toBe("not_subscription");
    expect(parseAuthStatus("??")).toBe("unknown");
    env = await makeEnv();
    expect(await checkClaudeAuth(env.ctx)).toBe("ok");
    process.env.FAKE_CLAUDE_AUTH = "none";
    expect(await checkClaudeAuth(env.ctx)).toBe("not_logged_in");
    expect(env.ctx.auth.canStart).toBe(false);
    delete process.env.FAKE_CLAUDE_AUTH;
  }, 30_000);
});
