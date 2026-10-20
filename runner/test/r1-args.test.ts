// R1' 起動引数（7.2・6.1）と子の環境（7.7）: 役割ごとの --tools・許可・拒否・サンドボックス、API キーとランナートークンが子に渡らない。
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { buildArgs, buildSettings, type LaunchSpec } from "../src/claude/args.ts";
import { checkInit, childEnv } from "../src/claude/env.ts";
import { COMMON_DENY } from "../src/claude/permissions.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BATON_RUNNER_TOKEN;
});

const base: LaunchSpec = {
  role: "member",
  sessionId: "11111111-1111-4111-8111-111111111111",
  resume: false,
  cwd: "/data/worktrees/abcd1234/demo/t1-r1",
  addDirs: [],
  model: "sonnet",
  fallbackModel: null,
  maxTurns: 80,
  maxBudgetUsd: 6,
  systemPrompt: "ROLE: member\n…",
  pluginDir: null,
  hasSkills: false,
  settingsPath: "/data/run/s/settings.json",
  oneTimeAllow: [],
  extraAllow: [],
  name: "baton:member:11111111",
};

function valuesOf(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith("--"); j++) out.push(args[j]!);
  return out;
}

describe("R1' 起動引数", () => {
  it("共通: -p stream-json 入出力、--setting-sources \"\"・--strict-mcp-config・manual + stdio、--bare は付けない", () => {
    const a = buildArgs(base);
    expect(a.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--model"]);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("manual");
    expect(a[a.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(a).not.toContain("--bare");
    expect(a[a.indexOf("--session-id") + 1]).toBe(base.sessionId);
    expect(a).not.toContain("--resume");
    expect(buildArgs({ ...base, resume: true })).toContain("--resume");
    expect(valuesOf(a, "--disallowedTools")).toEqual([...COMMON_DENY]);
    expect(JSON.parse(a[a.indexOf("--json-schema") + 1]!).type).toBe("object");
    expect(a[a.indexOf("--name") + 1]).toBe("baton:member:11111111");
  });

  it("COO: 読む道具だけ、--include-partial-messages、退避モデル", () => {
    const a = buildArgs({ ...base, role: "coo", cwd: "/data/coo", model: "opus", fallbackModel: "sonnet", maxTurns: 20, maxBudgetUsd: 1.5 });
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,WebFetch,WebSearch");
    expect(valuesOf(a, "--allowedTools")).toEqual(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    expect(a).toContain("--include-partial-messages");
    expect(a[a.indexOf("--fallback-model") + 1]).toBe("sonnet");
    expect(a[a.indexOf("--max-turns") + 1]).toBe("20");
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("1.5");
  });

  it("リーダー: Bash は git の読み取りだけ許可、--add-dir、サンドボックスで本体・worktrees・projects に書けない", () => {
    const a = buildArgs({ ...base, role: "leader", addDirs: ["/repo", "/data/worktrees"] });
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash,WebFetch,WebSearch,TodoWrite");
    expect(valuesOf(a, "--allowedTools")).toContain("Bash(git diff *)");
    expect(valuesOf(a, "--allowedTools")).not.toContain("Bash(npm run *)");
    expect(valuesOf(a, "--add-dir")).toEqual(["/repo", "/data/worktrees"]);
    const s = buildSettings({ role: "leader", denyWrite: ["/repo", "/data/worktrees", "/data/projects"] });
    expect(s.disableAllHooks).toBe(true);
    expect(s.sandbox!.filesystem.denyWrite).toEqual(["/repo", "/data/worktrees", "/data/projects"]);
    expect(s.sandbox!.enabled && s.sandbox!.failIfUnavailable && !s.sandbox!.allowUnsandboxedCommands && !s.sandbox!.autoAllowBashIfSandboxed).toBe(true);
  });

  it("メンバー: worktree の Edit だけ許可、スキルがあれば Skill、partial は付けない、サンドボックスは許可ドメインだけ（github.com は入れない）", () => {
    const a = buildArgs({ ...base, hasSkills: true, pluginDir: "/data/run/profiles/researcher/plugin", oneTimeAllow: ["Bash(npm install zod)"], extraAllow: ["make test"] });
    const allow = valuesOf(a, "--allowedTools");
    expect(allow).toContain("Edit(//data/worktrees/abcd1234/demo/t1-r1/**)");
    expect(allow).toContain("Skill");
    expect(allow).toContain("Bash(npm install zod)");
    expect(allow).toContain("Bash(make test)");
    expect(a[a.indexOf("--tools") + 1]).toContain(",Skill");
    expect(a[a.indexOf("--plugin-dir") + 1]).toBe("/data/run/profiles/researcher/plugin");
    expect(a).not.toContain("--include-partial-messages");
    const s = buildSettings({ role: "member", extraDomains: ["example.org"] });
    expect(s.sandbox!.network).toEqual({ strictAllowlist: true, allowedDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "example.org"] });
    expect(s.sandbox!.filesystem.denyRead).toContain("~/.config");
    expect(s.permissions.deny).toContain("Bash(git push *)");
    expect(buildSettings({ role: "coo" }).sandbox).toBeUndefined();
  });

  it("サンドボックスの読み取り拒否に Read の拒否と同じ秘密の型が入る（Bash からの迂回を防ぐ。D-118）", () => {
    const s = buildSettings({ role: "member", projectsRoot: "/Users/r/projects/" });
    const denyRead = s.sandbox!.filesystem.denyRead;
    for (const p of ["~/.ssh", "~/.aws", "~/.config", "~/.claude", "~/.claude.json", "~/.netrc", "~/.npmrc", "~/Library/Keychains", "//**/.env", "//**/.env.*", "//**/.dev.vars", "//**/.dev.vars.*", "//**/*.key"]) {
      expect(denyRead, p).toContain(p);
    }
    expect(denyRead).toContain("//Users/r/projects/**/*.pem");
    // CA の束を壊さないため、*.pem はどこでもではない
    expect(denyRead).not.toContain("//**/*.pem");
    expect(buildSettings({ role: "leader" }).sandbox!.filesystem.denyRead).toContain("//**/.env");
    // Read の拒否にある秘密は、すべてサンドボックスでも拒否している（ホームの置き場所・型）
    const readDeny = s.permissions.deny.filter((d) => d.startsWith("Read(")).map((d) => d.slice(5, -1).replace(/\/\*\*$/, ""));
    for (const r of readDeny) {
      const sb = r.startsWith("**/") ? `//${r}` : r;
      if (r === "**/*.pem") continue;
      if (r === "**/.dev.vars*") {
        expect(denyRead).toContain("//**/.dev.vars");
        continue;
      }
      expect(denyRead, r).toContain(sb);
    }
  });

  it("子の環境は許可リスト（ANTHROPIC_*・BATON_RUNNER_TOKEN・GH_TOKEN は渡らない。FAKE_* だけ通す）", () => {
    const e = childEnv({ home: "/Users/x", passthrough: { ANTHROPIC_API_KEY: "sk", BATON_RUNNER_TOKEN: "t", GH_TOKEN: "g", CLAUDE_CODE_USE_BEDROCK: "1", FAKE_CLAUDE_STEP_MS: "0", PATH: "/evil" } });
    expect(Object.keys(e).sort()).toEqual(
      ["CLAUDE_CODE_ENABLE_TASKS", "CLAUDE_CODE_ENABLE_TODO_TOOLS", "FAKE_CLAUDE_STEP_MS", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"].sort(),
    );
    expect(e.PATH).toBe("/Users/x/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(checkInit({ apiKeySource: "none", mcpServers: [] })).toBeNull();
    expect(checkInit({ apiKeySource: "ANTHROPIC_API_KEY", mcpServers: [] })).toMatch(/サブスク以外/);
    expect(checkInit({ apiKeySource: null, mcpServers: [] })).toMatch(/サブスク以外/);
    expect(checkInit({ apiKeySource: "none", mcpServers: ["claude.ai Gmail"] })).toMatch(/MCP/);
  });

  it("実際に起動した子に API キーとランナートークンが無い（ランナーの環境にあっても）", async () => {
    env = await makeEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.BATON_RUNNER_TOKEN = "runner-token-should-not-leak";
    // 引数と環境を書き出してから偽 claude に渡す小さな包み
    const dump = path.join(env.dir, "dump.json");
    const wrapper = path.join(env.dir, "claude-wrapper.sh");
    await writeFile(wrapper, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), env: process.env}))' "${dump}" "$@"\nexec "${path.resolve(import.meta.dirname, "../../tools/fake-claude/bin/claude")}" "$@"\n`);
    await chmod(wrapper, 0o755);
    (env.config as { claudeBin: string }).claudeBin = wrapper;
    env.api.ceoSays(COO_THREAD_ID, "[scenario-a] ショート動画の台本 10 本作りたい");
    await env.drain();
    const d = JSON.parse(await readFile(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(d.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(d.env.BATON_RUNNER_TOKEN).toBeUndefined();
    expect(d.argv).toContain("--strict-mcp-config");
    expect(d.argv[d.argv.indexOf("--append-system-prompt") + 1]!.split("\n")[0]).toBe("ROLE: coo");
    // CEO の好み（返答の言語の節だけ）が入り、Codex・MBA の節は入らない
    const prompt = d.argv[d.argv.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("ユーザーに見える文はすべて日本語で書く");
    expect(prompt).not.toContain("codex-review スキル");
    expect(prompt).not.toContain("~/.cache");
    // 偽 claude は環境に鍵があると終了コード 3 で止まる。返事が届いた＝渡っていない
    expect(env.api.agentMessages(COO_THREAD_ID).map((m) => m.body)).toEqual(["なんの動画ですか？"]);
  }, 30_000);
});
