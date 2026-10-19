// R2' 承認（7.6・D-45・D-53）: 許可リスト外の Bash は CEO に聞く。許可・拒否・10 分（テストでは短く）の時間切れ → 判断待ち → 許可で 1 回限りの許可ルールを付けて --resume。
// 自分の worktree の外への書き込みは聞かずに拒否。
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID } from "@baton/shared";
import { decidePermission, oneTimeRule } from "../src/claude/approval.ts";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

/** COO → リーダーの plan まで進める（メンバーの段階の手前） */
async function toMemberPhase(e: Env, text: string): Promise<string> {
  e.api.ceoSays(COO_THREAD_ID, text);
  await e.step(); // COO の delegate
  await e.step(); // リーダーの plan
  const instr = [...e.api.instructions.values()][0]!;
  expect(instr.phase).toBe("members");
  return instr.id;
}

describe("R2' 承認", () => {
  it("方針: worktree の外への Edit は拒否、~/projects と ~/baton-data の Read は許可、それ以外の Read は拒否、メンバーの Bash は聞く", () => {
    const base = { cwd: "/d/worktrees/x/p/t1-r1", home: "/Users/r", dataDir: "/d" };
    expect(decidePermission({ ...base, role: "member", toolName: "Write", toolInput: { file_path: "/d/worktrees/x/p/t1-r1/a.md" } }).kind).toBe("allow");
    expect(decidePermission({ ...base, role: "member", toolName: "Write", toolInput: { file_path: "/d/worktrees/x/p/a.md" } }).kind).toBe("deny");
    expect(decidePermission({ ...base, role: "member", toolName: "Edit", toolInput: { file_path: "/d/worktrees/x/p/t1-r1/.git/config" } }).kind).toBe("deny");
    expect(decidePermission({ ...base, role: "member", toolName: "Read", toolInput: { file_path: "/Users/r/projects/a/b.ts" } }).kind).toBe("allow");
    expect(decidePermission({ ...base, role: "member", toolName: "Read", toolInput: { file_path: "/etc/passwd" } }).kind).toBe("deny");
    expect(decidePermission({ ...base, role: "member", toolName: "Bash", toolInput: { command: "npm install zod" } }).kind).toBe("ask");
    expect(decidePermission({ ...base, role: "leader", toolName: "Bash", toolInput: { command: "npm install zod" } }).kind).toBe("deny");
    expect(decidePermission({ ...base, role: "member", toolName: "mcp__x", toolInput: {} }).kind).toBe("deny");
    expect(oneTimeRule("Bash", { command: "npm install zod" })).toBe("Bash(npm install zod)");
    // リーダーの読み取りの git（cwd が git ではないので cd / -C が要る。worktrees と本体の中だけ）
    const leader = { ...base, role: "leader" as const, cwd: "/d/leaders/p", readRoots: ["/Users/r/projects/app"] };
    expect(decidePermission({ ...leader, toolName: "Bash", toolInput: { command: "cd /d/worktrees/x/p/integration && git diff --stat" } }).kind).toBe("allow");
    expect(decidePermission({ ...leader, toolName: "Bash", toolInput: { command: "git -C /Users/r/projects/app log --oneline -5" } }).kind).toBe("allow");
    for (const bad of [
      "cd /d/worktrees/x && git push",
      "cd /etc && git log",
      "cd /d/worktrees/x && git log && rm -rf /",
      "cd /d/worktrees/x && git log & rm x",
      "git -C /d/worktrees/x diff --output=/tmp/a",
      "git -C /d/worktrees/x log; curl x",
      "git -C /d/worktrees/x -c core.pager=sh log",
      "cd relative && git log",
    ]) expect(decidePermission({ ...leader, toolName: "Bash", toolInput: { command: bad } }).kind, bad).toBe("deny");
    expect(oneTimeRule("Write", { file_path: "/a/b.md" })).toBe("Edit(//a/b.md)");
  });

  it("許可: 承認カードを作り、CEO が許可したらそのまま実行される（transcript に approval、セッションは awaiting_approval を経る）", async () => {
    env = await makeEnv();
    const id = await toMemberPhase(env, "承認の確認 [approve]");
    const run = env.step();
    await waitFor(() => [...env.api.decisions.values()].some((d) => d.kind === "approval"));
    const d = [...env.api.decisions.values()].find((d) => d.kind === "approval")!;
    expect(d.toolName).toBe("Bash");
    expect(d.toolInput).toMatchObject({ command: "echo ok > approved.txt" });
    expect(env.api.sessions.get(d.sessionId!)!.status).toBe("awaiting_approval");
    env.api.answerDecision(d.id, "allow");
    env.ctx.decisions.notify(d.id);
    await run;
    expect(env.api.transcript.some((t) => t.kind === "approval" && t.summary.startsWith("承認待ち: Bash"))).toBe(true);
    const task = [...env.api.tasks.values()][0]!;
    expect(task.status).toBe("done");
    expect(task.resultSummary).toContain("approved.txt を書きました");
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(existsSync(path.join(integration.worktreePath, "approved.txt"))).toBe(true);
    expect(env.api.instr(id).phase).toBe("leader");
  }, 30_000);

  it("拒否: 拒否の理由が渡り、実行されない", async () => {
    env = await makeEnv();
    await toMemberPhase(env, "承認の確認 [approve]");
    const run = env.step();
    await waitFor(() => [...env.api.decisions.values()].some((d) => d.kind === "approval"));
    const d = [...env.api.decisions.values()].find((d) => d.kind === "approval")!;
    env.api.answerDecision(d.id, "deny", "今回は不要");
    env.ctx.decisions.notify(d.id);
    await run;
    const task = [...env.api.tasks.values()][0]!;
    expect(task.resultSummary).toContain("承認されなかった");
    const integration = [...env.api.workspaces.values()].find((w) => w.purpose === "integration")!;
    expect(existsSync(path.join(integration.worktreePath, "approved.txt"))).toBe(false);
  }, 30_000);

  it("時間切れ: 拒否して中断 → セッション paused・判断（interrupted）→ 指示は needs_decision → 後で許可 → 1 回限りの許可で --resume して続く", async () => {
    env = await makeEnv({ env: { BATON_APPROVAL_WAIT_MS: "300" } });
    const id = await toMemberPhase(env, "承認の確認 [approve]");
    await env.step();
    const interrupted = [...env.api.decisions.values()].find((d) => d.kind === "interrupted")!;
    expect(interrupted).toBeTruthy();
    const approval = [...env.api.decisions.values()].find((d) => d.kind === "approval")!;
    expect(approval.status).toBe("canceled");
    const s = env.api.sessions.get(interrupted.sessionId!)!;
    expect(s.status).toBe("paused");
    expect(s.pauseReason).toBe("approval");
    expect(env.api.instr(id).status).toBe("needs_decision");

    env.api.answerDecision(interrupted.id, "allow");
    const r = await env.step();
    expect(r?.kind).toBe("instruction");
    // 同じセッションを --resume（新しいセッションは増えない）
    expect([...env.api.sessions.values()].filter((x) => x.role === "member")).toHaveLength(1);
    expect(env.api.sessions.get(s.id)!.status).toBe("done");
    expect(env.api.transcript.some((t) => t.sessionId === s.id && t.summary === "再開")).toBe(true);
    expect(env.api.transcript.some((t) => t.sessionId === s.id && t.kind === "user" && String((t.body as { text?: string }).text).includes("[CEO の回答] CEO が許可した"))).toBe(true);
    expect([...env.api.tasks.values()][0]!.status).toBe("done");
  }, 30_000);

  it("worktree の外への書き込み（[deny]）は聞かずに拒否される", async () => {
    env = await makeEnv();
    await toMemberPhase(env, "外に書く [deny]");
    await env.step();
    expect([...env.api.decisions.values()]).toHaveLength(0);
    expect([...env.api.tasks.values()][0]!.resultSummary).toContain("拒否されました");
  }, 30_000);
});
