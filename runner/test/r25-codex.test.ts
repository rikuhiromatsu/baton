// R25 Codex レビュー（6.4・D-87）: 偽の codex-review.sh で、条件（既存リポジトリ・コードの差分・codexReview の職種）のときだけ統合後に 1 回、
// 指摘がリーダーの受信箱に review_findings で入る。BATON_CODEX_REVIEW=off で回らない。
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, makeSampleRepo, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

async function setup(opts: { codex: "on" | "off"; profile: string; file: string; kind?: "repo" | "baton" }) {
  const { tempDir } = await import("./helpers.ts");
  const t = await tempDir();
  const script = path.join(t.dir, "codex-review.sh");
  const log = path.join(t.dir, "codex.log");
  await writeFile(script, `#!/bin/sh\necho "$@ $(pwd)" >> "${log}"\necho "指摘: src の変数名が分かりにくい"\n`);
  await chmod(script, 0o755);
  env = await makeEnv({ env: { BATON_CODEX_REVIEW: opts.codex, BATON_CODEX_SCRIPT: script } });
  const repo = await makeSampleRepo(path.join(env.home, "projects"));
  const p = env.api.addProject(
    { slug: "app", name: "アプリ", workspaceKind: opts.kind ?? "repo", repoPath: (opts.kind ?? "repo") === "repo" ? repo : null },
    { members: [{ name: "エンジニア", profile: opts.profile }] },
  );
  env.api.ceoSays(`thread-${p.id}`, "直して");
  // リーダーの plan を 1 つのファイルにする（偽 claude の汎用の台本は output/… に書くので paths で決める）
  await env.step();
  const task = [...env.api.tasks.values()][0]!;
  task.paths = [opts.file];
  await env.step(); // メンバー → 統合 → Codex → member_results
  return { log, p, cleanup: t.cleanup };
}

describe("R25 Codex レビュー", () => {
  it("条件を満たすと統合後に 1 回、--base <base_sha> で統合用 worktree で回し、review_findings に入る", async () => {
    const { log, p, cleanup } = await setup({ codex: "on", profile: "engineer", file: "src/app.ts" });
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(calls[0]).toBe(`review --base ${integration.baseSha} ${integration.worktreePath}`);
    const f = env.api.inbox.find((i) => i.kind === "review_findings")!;
    expect(f.threadId).toBe(`thread-${p.id}`);
    expect(String(f.payload.text)).toContain("変数名");
    await cleanup();
  }, 30_000);

  it("off・コード以外の差分・codexReview の職種がいない・Baton 専用では回らない", async () => {
    for (const c of [
      { codex: "off" as const, profile: "engineer", file: "src/app.ts" },
      { codex: "on" as const, profile: "engineer", file: "docs/readme.md" },
      { codex: "on" as const, profile: "writer", file: "src/app.ts" },
      { codex: "on" as const, profile: "engineer", file: "src/app.ts", kind: "baton" as const },
    ]) {
      const { log, cleanup } = await setup(c);
      expect(await readFile(log, "utf8").catch(() => "")).toBe("");
      expect(env.api.inbox.some((i) => i.kind === "review_findings")).toBe(false);
      expect(env.api.inbox.some((i) => i.kind === "member_results")).toBe(true);
      await env.cleanup();
      await cleanup();
    }
  }, 60_000);
});
