// W23 リポジトリと紐づけ、W24 枠、W25 確定、W27 サイドパネルと組織図（DESIGN-v2 3.2・7.5・9 章・13.3・13.9）
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  InstructionSummary,
  OrgSnapshot,
  ProfileView,
  ProjectProposal,
  ProjectWithTeam,
  QuotaStatus,
  RepoCandidate,
  ServerEvent,
  SidebarOutput,
  ThreadMessage,
  WorkspaceDiff,
} from "@baton/shared";
import {
  browser,
  claim,
  clearWork,
  createProject,
  createSession,
  insertInstruction,
  login,
  membersInstruction,
  openSocket,
  ORIGIN,
  registerRunner,
  runner,
  runnerCreateInstruction,
  type TestRunner,
} from "./helpers.ts";

const QUOTA: QuotaStatus = {
  observedAt: 1_700_000_000_000,
  fiveHour: { utilization: 0.67, resetsAt: 1_700_000_100_000 },
  sevenDay: { utilization: 0.28, resetsAt: 1_700_500_000_000 },
  status: "allowed",
  rejectedType: null,
  blockedUntil: null,
  paused: false,
};
const PROFILES: ProfileView[] = [
  { id: "researcher", role: "member", model: "sonnet", skills: ["sns-url-research"], tools: ["Read", "Skill"], mcp: [], codexReview: false },
];

function heartbeat(r: TestRunner, extra: Record<string, unknown> = {}) {
  return runner(r, "/api/runner/heartbeat", {
    body: { version: "2.0.0", tailnetUrl: null, activeInstructionIds: [], activeSessionIds: [], activeThreadIds: [], quota: QUOTA, claudeVersion: "2.1.303", claudeAuth: "ok", profiles: PROFILES, ...extra },
  });
}

async function putRepos(r: TestRunner, paths: string[]) {
  const res = await runner(r, "/api/runner/repos", {
    method: "PUT",
    body: { items: paths.map((p) => ({ path: p, name: p.split("/").slice(-2).join("/"), defaultBranch: "main", headSha: "a".repeat(40), lastCommitAt: 1, dirty: p.endsWith("dirty") })) },
  });
  expect(res.status).toBe(204);
}

describe("W23 リポジトリの候補と紐づけ", () => {
  it("PUT で候補を置き換え（24 時間見えなければ消す）、GET /api/repos に紐づき先、相対パスは 400", async () => {
    const s = await login();
    const r = await registerRunner();
    const base = `/Users/x/projects/${crypto.randomUUID().slice(0, 6)}`;
    await env.DB.prepare("INSERT INTO runner_repos (path, runner_id, name, seen_at) VALUES (?, ?, 'old', ?)").bind(`${base}/old`, r.runnerId, Date.now() - 25 * 3600_000).run();
    await putRepos(r, [`${base}/app`, `${base}/dirty`]);
    const repos = ((await (await browser(s, "/api/repos")).json()) as { items: RepoCandidate[] }).items.filter((x) => x.path.startsWith(base));
    expect(repos.map((x) => x.path).sort()).toEqual([`${base}/app`, `${base}/dirty`]);
    expect(repos.find((x) => x.path.endsWith("dirty"))?.dirty).toBe(true);
    expect((await runner(r, "/api/runner/repos", { method: "PUT", body: { items: [{ path: "rel/path", name: "x", defaultBranch: null, headSha: null, lastCommitAt: null, dirty: false }] } })).status).toBe(400);
  });

  it("PATCH で紐づけ・外す（候補外は 400、他のプロジェクトのものは 409、動いている指示があれば 409）。目的も変えられる", async () => {
    const s = await login();
    const r = await registerRunner();
    const base = `/Users/x/projects/${crypto.randomUUID().slice(0, 6)}`;
    await putRepos(r, [`${base}/one`, `${base}/two`]);
    const p = await createProject(r);
    const q = await createProject(r);
    const patch = (id: string, body: unknown) => browser(s, `/api/projects/${id}`, { method: "PATCH", body });
    expect((await patch(p.project.id, { repoPath: "/not/a/candidate" })).status).toBe(400);
    const linked = (await (await patch(p.project.id, { repoPath: `${base}/one`, baseBranch: "develop", goal: "新しい目的" })).json()) as ProjectWithTeam;
    expect(linked).toMatchObject({ workspaceKind: "repo", repoPath: `${base}/one`, repoName: expect.stringContaining("one"), baseBranch: "develop", goal: "新しい目的" });
    expect((await patch(q.project.id, { repoPath: `${base}/one` })).status).toBe(409);
    const repos = ((await (await browser(s, "/api/repos")).json()) as { items: RepoCandidate[] }).items;
    expect(repos.find((x) => x.path === `${base}/one`)?.projectId).toBe(p.project.id);
    await runnerCreateInstruction(r, p.project.id);
    expect((await patch(p.project.id, { repoPath: null })).status).toBe(409);
    expect((await patch(p.project.id, { goal: "目的だけは変えられる" })).status).toBe(200);
    await clearWork();
    const unlinked = (await (await patch(p.project.id, { repoPath: null })).json()) as ProjectWithTeam;
    expect(unlinked).toMatchObject({ workspaceKind: "baton", repoPath: null });
    expect((await patch(crypto.randomUUID(), { goal: "x" })).status).toBe(404);
  });

  it("「リポジトリから作る」はプロジェクト案と COO スレッドのカード・受信箱を作る（紐づき済みは 409、候補外は 400）", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const base = `/Users/x/projects/${crypto.randomUUID().slice(0, 6)}`;
    await putRepos(r, [`${base}/My_Repo`]);
    const res = await browser(s, "/api/projects", { body: { repoPath: `${base}/My_Repo` } });
    expect(res.status).toBe(201);
    const { proposal } = (await res.json()) as { proposal: ProjectProposal };
    expect(proposal).toMatchObject({ status: "pending", slug: "my-repo", workspace: { kind: "repo", repoPath: `${base}/My_Repo` } });
    const card = await env.DB.prepare("SELECT kind FROM thread_messages WHERE thread_id = 'thread-coo' AND json_extract(ref, '$.proposalId') = ?").bind(proposal.id).first();
    expect(card).toEqual({ kind: "project_proposal" });
    const inbox = await env.DB.prepare("SELECT wakes FROM thread_inbox WHERE thread_id = 'thread-coo' AND json_extract(payload, '$.proposalId') = ?").bind(proposal.id).first();
    expect(inbox).toEqual({ wakes: 1 });
    expect((await browser(s, "/api/projects", { body: { repoPath: "/nope" } })).status).toBe(400);
    const p = await createProject(r);
    await browser(s, `/api/projects/${p.project.id}`, { method: "PATCH", body: { repoPath: `${base}/My_Repo` } });
    expect((await browser(s, "/api/projects", { body: { repoPath: `${base}/My_Repo` } })).status).toBe(409);
  });
});

describe("W24 枠", () => {
  it("ハートビートの quota を記録し、変わったら quota.updated。GET /api/quota に今日の推定額。プロファイルとランナーの認証も", async () => {
    const s = await login();
    const r = await registerRunner();
    const ws = await openSocket("/api/ws", { Origin: ORIGIN, Cookie: s.cookie });
    await ws.waitFor((e) => e.t === "hello");
    expect((await heartbeat(r)).status).toBe(200);
    const ev = await ws.waitFor<Extract<ServerEvent, { t: "quota.updated" }>>((e) => e.t === "quota.updated");
    expect(ev.quota.fiveHour.utilization).toBe(0.67);
    await ws.waitFor((e) => e.t === "runner.status" && e.runner.claudeAuth === "ok" && e.runner.claudeVersion === "2.1.303");
    const sid = await createSession(r, { threadId: "thread-coo", role: "coo" });
    await runner(r, `/api/runner/sessions/${sid}`, { method: "PATCH", body: { costUsdDelta: 0.5 } });
    const q = (await (await browser(s, "/api/quota")).json()) as QuotaStatus & { estimatedCostTodayUsd: number };
    expect(q).toMatchObject({ fiveHour: { utilization: 0.67 }, sevenDay: { utilization: 0.28 }, status: "allowed" });
    expect(q.estimatedCostTodayUsd).toBeGreaterThanOrEqual(0.5);
    const profiles = (await (await browser(s, "/api/profiles")).json()) as { items: ProfileView[] };
    expect(profiles.items).toEqual(PROFILES);
    // 同じ値なら quota.updated は出ない
    const before = ws.events.filter((e) => e.t === "quota.updated").length;
    await heartbeat(r);
    await new Promise((res) => setTimeout(res, 250));
    expect(ws.events.filter((e) => e.t === "quota.updated").length).toBe(before);
    ws.close();
  });

  it("枠切れでスレッドを not_before 付きで外すと、その時刻まで claim されない", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    await browser(s, "/api/threads/thread-coo/messages", { body: { clientId: crypto.randomUUID(), body: "枠のテスト" } });
    expect((await claim(r, ["thread"])).status).toBe(200);
    const until = Date.now() + 60_000;
    expect((await runner(r, "/api/runner/threads/thread-coo/release", { body: { reason: "quota", notBefore: until } })).status).toBe(204);
    expect((await env.DB.prepare("SELECT status, not_before FROM threads WHERE id = 'thread-coo'").first())).toEqual({ status: "queued", not_before: until });
    expect((await claim(r, ["thread"])).status).toBe(204);
    await env.DB.prepare("UPDATE threads SET not_before = ? WHERE id = 'thread-coo'").bind(Date.now() - 1).run();
    expect((await claim(r, ["thread"])).status).toBe(200);
  });
});

describe("W25 確定", () => {
  it("finalize を claim して、作業場所を片付けて finalized。衝突は COO スレッドに知らせ。lease が無いと 409", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r);
    const id = await insertInstruction(s.userId, { status: "done", projectId: p.project.id, statusChangedAt: Date.now() - 30_000, title: "台本" });
    const ws = crypto.randomUUID();
    const wsRes = await runner(r, "/api/runner/workspaces", {
      body: { id: ws, instructionId: id, projectId: p.project.id, purpose: "integration", taskId: null, parentId: null, kind: "baton", repoPath: "/d/projects/x", worktreePath: `/d/worktrees/${ws}`, branch: "baton/12345678/integration", baseRef: "main", baseSha: "b".repeat(40) },
    });
    expect(wsRes.status).toBe(201);
    expect((await runner(r, `/api/runner/instructions/${id}/finalized`, { body: { outcome: "merged", branch: null } })).status).toBe(409);
    const c = await claim(r, ["finalize"]);
    expect(c.status).toBe(200);
    const patched = await runner(r, `/api/runner/workspaces/${ws}`, {
      method: "PATCH",
      body: { status: "kept", headSha: "c".repeat(40), diffStat: [{ path: "a.md", added: 3, removed: 1, change: "M" }], diffPatch: "diff --git a/a.md b/a.md", diffTruncated: false, finalized: true },
    });
    expect(patched.status).toBe(200);
    const fin = await runner(r, `/api/runner/instructions/${id}/finalized`, { body: { outcome: "conflict", branch: "baton/12345678/integration" } });
    expect(fin.status).toBe(200);
    const row = await env.DB.prepare("SELECT finalized_at, lease_runner_id FROM instructions WHERE id = ?").bind(id).first<{ finalized_at: number | null; lease_runner_id: string | null }>();
    expect(row!.finalized_at).not.toBeNull();
    expect(row!.lease_runner_id).toBeNull();
    const notice = await env.DB.prepare("SELECT body, kind FROM thread_messages WHERE thread_id = 'thread-coo' AND instruction_id = ? AND kind = 'notice'").bind(id).first<{ body: string }>();
    expect(notice?.body).toContain("baton/12345678/integration");
    expect((await claim(r, ["finalize"])).status).toBe(204);
    const diff = (await (await browser(s, `/api/instructions/${id}/diff`)).json()) as WorkspaceDiff;
    expect(diff).toMatchObject({ files: [{ path: "a.md", added: 3 }], patch: "diff --git a/a.md b/a.md", truncated: false, workspace: { status: "kept", branch: "baton/12345678/integration" } });
    const list = (await (await runner(r, `/api/runner/workspaces?status=kept,active&instructionId=${id}`)).json()) as { items: { id: string }[] };
    expect(list.items.map((x) => x.id)).toEqual([ws]);
  });

  it("reopen で done → running（finalized_at を消す）。承認を取り消せる期限のあいだは finalize に出さない", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const p = await createProject(r);
    const id = await insertInstruction(s.userId, { status: "review", projectId: p.project.id, phase: "coo" });
    await browser(s, `/api/instructions/${id}/transition`, { body: { action: "approve", expectedStatus: "review" } });
    expect((await claim(r, ["finalize"])).status).toBe(204);
    const res = await runner(r, `/api/runner/instructions/${id}`, { method: "PATCH", body: { reopen: true, phase: "leader", revisionBump: true } });
    expect(res.status).toBe(200);
    expect((await res.json()) as InstructionSummary).toMatchObject({ status: "running", phase: "leader", revision: 2, completedAt: null });
  });
});

describe("W27 サイドパネルと組織図", () => {
  it("件数・並び・話し中・承認待ち・エージェントの状態", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const busy = await createProject(r, undefined, "忙しい");
    const quiet = await createProject(r, undefined, "静か");
    const a = await membersInstruction(r, busy.project.id);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id, agentId: busy.memberIds[0], projectId: busy.project.id, taskId: a.taskId });
    await runner(r, `/api/runner/sessions/${sid}`, { method: "PATCH", body: { status: "running", activity: "調べている コーヒー" } });
    await runner(r, "/api/runner/approvals", { body: { id: crypto.randomUUID(), instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: busy.memberIds[0], toolName: "Bash", toolInput: {}, toolUseId: null, question: "q" } });
    await insertInstruction(s.userId, { status: "review", projectId: quiet.project.id });
    // CEO が「静か」のリーダーに話しかけている
    await browser(s, `/api/threads/${quiet.leaderThreadId}/messages`, { body: { clientId: crypto.randomUUID(), body: "方向を変えたい" } });

    const sidebar = (await (await browser(s, "/api/projects/sidebar")).json()) as SidebarOutput;
    const ids = sidebar.items.map((i) => i.project.id);
    expect(ids.indexOf(busy.project.id)).toBeLessThan(ids.indexOf(quiet.project.id));
    const b = sidebar.items.find((i) => i.project.id === busy.project.id)!;
    expect(b.counts).toMatchObject({ needsDecision: 1, running: 0 });
    expect(b.inProgress).toBe(true);
    expect(b.activeAgents).toBeGreaterThanOrEqual(1);
    expect(b.activity).toBe("調べている コーヒー");
    const q = sidebar.items.find((i) => i.project.id === quiet.project.id)!;
    expect(q.counts.review).toBe(1);
    expect(q.leaderThread.talkingWithCeo).toBe(true);
    expect(sidebar.approvals).toBeGreaterThanOrEqual(1);

    const org = (await (await browser(s, "/api/org")).json()) as OrgSnapshot;
    expect(org.coo.thread.id).toBe("thread-coo");
    const bp = org.projects.find((x) => x.project.id === busy.project.id)!;
    const member = bp.members.find((m) => m.agent.id === busy.memberIds[0])!;
    expect(member.state).toBe("awaiting_approval");
    expect(member.work).toEqual([expect.objectContaining({ sessionId: sid, instructionId: a.id, activity: "調べている コーヒー" })]);
    expect(member.agent.profile).toBe("researcher");
    const qp = org.projects.find((x) => x.project.id === quiet.project.id)!;
    expect(qp.leader?.state).toBe("talking");
    expect(qp.leader?.threadId).toBe(quiet.leaderThreadId);
    // 指示のカードにも話し中と動いているエージェント
    const list = (await (await browser(s, `/api/instructions?projectId=${busy.project.id}`)).json()) as { items: InstructionSummary[] };
    expect(list.items.map((i) => i.id)).toEqual([a.id]);
    expect(list.items[0]!.activeAgents).toEqual([expect.objectContaining({ agentId: busy.memberIds[0], role: "member" })]);
    expect(list.items[0]!.openDecisionCount).toBe(1);
    const msgs = (await (await browser(s, `/api/threads/${quiet.leaderThreadId}/messages`)).json()) as { items: ThreadMessage[] };
    expect(msgs.items.at(-1)?.authorKind).toBe("ceo");
  });
});
