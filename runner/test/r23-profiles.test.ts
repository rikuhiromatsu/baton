// R23 プロファイル（6 章・D-84〜D-86）: --plugin-dir の組み立てとスキルの写し（シンボリックリンクは実体を写す）、
// neverSkills を外す、スキルの allowed-tools が拒否に当たれば外す、ceoStyle の見出しの取り込み、profiles.local.json の上書き。
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginDir, buildSystemPrompt, extractSections, listPluginSkills, loadProfiles, parseAllowedTools, profileViews } from "../src/claude/profiles.ts";
import { COMMON_DENY, deniedBy } from "../src/claude/permissions.ts";
import { REPO_ROOT, makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

describe("R23 プロファイル", () => {
  it("リポジトリの既定（profiles.json）: researcher に 2 つのスキル、COO は opus、engineer は codexReview", async () => {
    env = await makeEnv();
    const p = await loadProfiles(env.config);
    expect(p.file.profiles.researcher!.skills).toEqual(["sns-url-research", "prior-art-search"]);
    expect(p.file.profiles.coo!.model).toBe("opus");
    expect(p.file.profiles.engineer!.codexReview).toBe(true);
    expect(p.file.neverSkills).toContain("linear-task");
    const views = profileViews(p);
    expect(views.find((v) => v.id === "researcher")!.tools).toContain("Skill");
    expect(views.find((v) => v.id === "coo")!.tools).toEqual(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
    expect(env.config.profilesPath).toBe(path.join(REPO_ROOT, "runner/profiles/profiles.json"));
  });

  it("neverSkills・無いスキル・拒否に当たる allowed-tools のスキルは外して警告", async () => {
    env = await makeEnv();
    const skills = path.join(env.home, ".claude/skills");
    await mkdir(path.join(skills, "pusher"), { recursive: true });
    await writeFile(path.join(skills, "pusher/SKILL.md"), "---\nname: pusher\nallowed-tools: Bash(git push *), Read\n---\n");
    await mkdir(path.join(skills, "safe"), { recursive: true });
    await writeFile(path.join(skills, "safe/SKILL.md"), "---\nname: safe\nallowed-tools: Read Grep\n---\n");
    await mkdir(path.dirname(env.config.profilesLocalPath), { recursive: true });
    await writeFile(env.config.profilesLocalPath, JSON.stringify({ profiles: { writer: { skills: ["linear-task", "pusher", "safe", "nothing"] } } }));
    const p = await loadProfiles(env.config);
    expect(p.file.profiles.writer!.skills).toEqual(["safe"]);
    expect(p.warnings.join("\n")).toMatch(/linear-task は neverSkills/);
    expect(p.warnings.join("\n")).toMatch(/pusher の allowed-tools が拒否に当たる/);
    expect(p.warnings.join("\n")).toMatch(/nothing が ~\/.claude\/skills に無い/);
    // 他のキーは既定のまま
    expect(p.file.profiles.researcher!.skills).toEqual(["sns-url-research", "prior-art-search"]);
  });

  it("allowed-tools の読み方と拒否の判定", () => {
    expect(parseAllowedTools("---\nname: x\nallowed-tools: Bash(git diff *), Read\n---")).toEqual(["Bash(git diff *)", "Read"]);
    expect(parseAllowedTools("---\nallowed-tools:\n  - Read\n  - Bash(npm run *)\n---")).toEqual(["Read", "Bash(npm run *)"]);
    expect(parseAllowedTools("---\nname: x\n---")).toEqual([]);
    expect(deniedBy("Bash(git push origin main)", COMMON_DENY)).toBe("Bash(git push *)");
    expect(deniedBy("Bash", COMMON_DENY)).not.toBeNull();
    expect(deniedBy("Bash(npm run *)", COMMON_DENY)).toBeNull();
    expect(deniedBy("Bash(rmdir x)", COMMON_DENY)).toBe("Bash(rmdir *)");
    expect(deniedBy("Read", COMMON_DENY)).toBeNull();
    expect(deniedBy("Read(~/.claude/**)", COMMON_DENY)).toBe("Read(~/.claude/**)");
  });

  it("--plugin-dir: plugin.json とスキルの写し（シンボリックリンクは実体を写す）。起動のたびに作り直す", async () => {
    env = await makeEnv();
    // 本人の環境と同じく、スキルは別の場所へのシンボリックリンク
    const real = path.join(env.dir, "claude-config/skills/sns-url-research");
    await mkdir(path.join(real, "references"), { recursive: true });
    await writeFile(path.join(real, "SKILL.md"), "---\nname: sns-url-research\n---\n本文 v1\n");
    await writeFile(path.join(real, "references/guide.md"), "参考\n");
    const link = path.join(env.home, ".claude/skills/sns-url-research");
    await (await import("node:fs/promises")).rm(link, { recursive: true, force: true });
    await symlink(real, link);
    const p = await loadProfiles(env.config);
    const dir = (await buildPluginDir(env.config, "researcher", p.file.profiles.researcher!))!;
    expect(dir).toBe(path.join(env.dataDir, "run/profiles/researcher/plugin"));
    expect(JSON.parse(await readFile(path.join(dir, ".claude-plugin/plugin.json"), "utf8")).name).toBe("baton-researcher");
    expect(await listPluginSkills(dir)).toEqual(["prior-art-search", "sns-url-research"]);
    expect((await lstat(path.join(dir, "skills/sns-url-research"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dir, "skills/sns-url-research/references/guide.md"), "utf8")).toBe("参考\n");
    await writeFile(path.join(real, "SKILL.md"), "---\nname: sns-url-research\n---\n本文 v2\n");
    await buildPluginDir(env.config, "researcher", p.file.profiles.researcher!);
    expect(await readFile(path.join(dir, "skills/sns-url-research/SKILL.md"), "utf8")).toContain("本文 v2");
    expect(await buildPluginDir(env.config, "writer", p.file.profiles.writer!)).toBeNull();
  });

  it("偽 claude の init に researcher のスキルが出る（メンバーの起動で --plugin-dir が効く）", async () => {
    env = await makeEnv();
    const p = env.api.addProject({ slug: "rs", name: "調査" }, { members: [{ name: "リサーチ", profile: "researcher" }] });
    env.api.ceoSays(`thread-${p.id}`, "競合を調べて");
    await env.drain();
    const init = env.api.transcript.find((t) => t.kind === "system" && t.summary === "開始" && (t.body as { skills?: string[] }).skills?.some((s) => s.startsWith("baton-researcher:")))!;
    expect((init.body as { skills: string[] }).skills).toEqual(expect.arrayContaining(["baton-researcher:sns-url-research", "baton-researcher:prior-art-search"]));
  }, 30_000);

  it("CEO の好み: CLAUDE.md の「## 見出し」単位で includeSections だけ、役割の 1 行目は ROLE:", async () => {
    const md = "# 共通\n\n## 返答の言語\n\n日本語で。\n\n### 細かい点\n\n敬体。\n\n## Codex によるクロスレビュー\n\n必ず。\n";
    expect(extractSections(md, ["返答の言語"])).toBe("日本語で。\n\n### 細かい点\n\n敬体。");
    env = await makeEnv();
    const p = await loadProfiles(env.config);
    const prompt = await buildSystemPrompt({ config: env.config, profiles: p, role: "member", profileId: "researcher", goal: "目的 X" });
    expect(prompt.split("\n")[0]).toBe("ROLE: member");
    expect(prompt).toContain("ユーザーに見える文はすべて日本語で書く。");
    expect(prompt).toContain("CEO（本人）は日本語で話す。");
    expect(prompt).not.toContain("codex-review スキルで");
    expect(prompt).toContain("出典の URL を必ず残す");
    expect(prompt).toContain("## プロジェクトの目的\n目的 X");
  });
});
