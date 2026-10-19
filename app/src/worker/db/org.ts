// サイドパネルと組織図の集計（DESIGN-v2 12.6・13.3・13.9）
import {
  compareSidebarProjects,
  countInstructions,
  deriveAgentState,
  isProjectInProgress,
  type Agent,
  type AgentLive,
  type InstructionStatus,
  type OrgSnapshot,
  type ProjectCounts,
  type ProjectSidebarItem,
  type ProjectWithTeam,
  type SessionStatus,
  type ThreadSummary,
} from "@baton/shared";
import { listProjects } from "./projects.ts";
import { getQuota, getRunnerStatus } from "./runners.ts";
import { listThreadSummaries } from "./threads.ts";
import { toAgent, type AgentRow } from "./rows.ts";

type CountRow = { project_id: string | null; status: InstructionStatus; open_decisions: number; completed_at: number | null; status_changed_at: number };

const COUNT_SELECT = `SELECT i.project_id, i.status, i.completed_at, i.status_changed_at,
  (SELECT count(*) FROM decisions d WHERE d.instruction_id = i.id AND d.status = 'open') AS open_decisions
  FROM instructions i WHERE i.status NOT IN ('archived','canceled')`;

function countsFrom(rows: CountRow[], now: number): ProjectCounts {
  return countInstructions(
    rows.map((r) => ({ status: r.status, openDecisionCount: r.open_decisions, completedAt: r.completed_at, statusChangedAt: r.status_changed_at })),
    now,
  );
}

export async function projectCounts(db: D1Database, projectId: string, now: number): Promise<ProjectCounts> {
  const { results } = await db.prepare(`${COUNT_SELECT} AND i.project_id = ?`).bind(projectId).all<CountRow>();
  return countsFrom(results, now);
}

type LiveSessionRow = {
  id: string;
  agent_id: string | null;
  instruction_id: string | null;
  thread_id: string | null;
  project_id: string | null;
  status: SessionStatus;
  title: string;
  activity: string | null;
  started_at: number | null;
  created_at: number;
  updated_at: number;
  instruction_title: string | null;
};

type OrgData = {
  projects: ProjectWithTeam[];
  counts: Map<string, ProjectCounts>;
  threads: ThreadSummary[];
  sessions: LiveSessionRow[];
  lastActiveByAgent: Map<string, number>;
  lastWorkByAgent: Map<string, { sessionId: string; instructionId: string }>;
  agentsWithDecision: Set<string>;
  lastActivityByProject: Map<string, number>;
  approvals: number;
  coo: Agent | null;
};

async function loadOrgData(db: D1Database, userId: string | null, now: number): Promise<OrgData> {
  const [projects, threads] = await Promise.all([listProjects(db, { activeOnly: true }), listThreadSummaries(db, userId)]);
  const [countRows, sessions, lastActive, decisionAgents, lastActivity, approvals, coo, lastWork] = await db.batch([
    db.prepare(COUNT_SELECT),
    db.prepare(
      `SELECT s.id, s.agent_id, s.instruction_id, s.thread_id, s.project_id, s.status, s.title, s.activity, s.started_at, s.created_at, s.updated_at,
              COALESCE(i.title, substr(i.body, 1, 60)) AS instruction_title
         FROM agent_sessions s LEFT JOIN instructions i ON i.id = s.instruction_id
        WHERE s.status IN ('pending','running','awaiting_approval','paused','quota_wait') AND s.role <> 'legacy'
        ORDER BY s.created_at`,
    ),
    db.prepare("SELECT agent_id, max(updated_at) AS at FROM agent_sessions WHERE agent_id IS NOT NULL GROUP BY agent_id"),
    db.prepare("SELECT DISTINCT asked_by_agent_id AS agent_id FROM decisions WHERE status = 'open' AND kind <> 'approval' AND asked_by_agent_id IS NOT NULL"),
    db.prepare(
      `SELECT p.id AS project_id, max(COALESCE((SELECT max(i.updated_at) FROM instructions i WHERE i.project_id = p.id), 0),
                                      COALESCE((SELECT t.last_message_at FROM threads t WHERE t.project_id = p.id AND t.kind = 'leader'), 0)) AS at
         FROM projects p WHERE p.status = 'active'`,
    ),
    db.prepare("SELECT count(*) AS n FROM decisions WHERE status = 'open' AND kind = 'approval'"),
    db.prepare("SELECT * FROM agents WHERE role = 'coo' LIMIT 1"),
    db.prepare(
      // SQLite の max() の集計では、ほかの列はその最大の行の値になる（エージェントごとに直近の 1 行）
      `SELECT s.agent_id, s.id AS session_id, s.instruction_id, max(s.updated_at) AS at
         FROM agent_sessions s
        WHERE s.agent_id IS NOT NULL AND s.instruction_id IS NOT NULL AND s.role <> 'legacy'
        GROUP BY s.agent_id`,
    ),
  ]);
  const lastWorkByAgent = new Map<string, { sessionId: string; instructionId: string }>();
  for (const r of (lastWork?.results ?? []) as { agent_id: string; session_id: string; instruction_id: string }[]) {
    if (!lastWorkByAgent.has(r.agent_id)) lastWorkByAgent.set(r.agent_id, { sessionId: r.session_id, instructionId: r.instruction_id });
  }
  const byProject = new Map<string, CountRow[]>();
  for (const r of (countRows?.results ?? []) as CountRow[]) {
    if (!r.project_id) continue;
    (byProject.get(r.project_id) ?? byProject.set(r.project_id, []).get(r.project_id)!).push(r);
  }
  const counts = new Map(projects.map((p) => [p.id, countsFrom(byProject.get(p.id) ?? [], now)]));
  const cooRow = ((coo?.results ?? []) as AgentRow[])[0];
  return {
    projects,
    counts,
    threads,
    sessions: (sessions?.results ?? []) as LiveSessionRow[],
    lastWorkByAgent,
    lastActiveByAgent: new Map(((lastActive?.results ?? []) as { agent_id: string; at: number }[]).map((r) => [r.agent_id, r.at])),
    agentsWithDecision: new Set(((decisionAgents?.results ?? []) as { agent_id: string }[]).map((r) => r.agent_id)),
    lastActivityByProject: new Map(((lastActivity?.results ?? []) as { project_id: string; at: number }[]).map((r) => [r.project_id, r.at])),
    approvals: ((approvals?.results?.[0] as { n: number } | undefined)?.n ?? 0) as number,
    coo: cooRow ? toAgent(cooRow) : null,
  };
}

function agentLive(agent: Agent, data: OrgData, thread: ThreadSummary | null): AgentLive {
  const mine = data.sessions.filter((s) => s.agent_id === agent.id);
  const state = deriveAgentState({
    sessionStatuses: mine.map((s) => s.status),
    hasOpenDecision: data.agentsWithDecision.has(agent.id),
    threadStatus: thread?.status ?? null,
    talkingWithCeo: thread?.talkingWithCeo ?? false,
  });
  const work = mine.map((s) => ({
    sessionId: s.id,
    instructionId: s.instruction_id,
    title: s.instruction_title ?? (thread ? thread.agentName : s.title),
    activity: s.activity,
    since: s.started_at ?? s.created_at,
  }));
  return {
    agent,
    state,
    threadId: thread?.id ?? null,
    work,
    lastActiveAt: data.lastActiveByAgent.get(agent.id) ?? null,
    lastWork: data.lastWorkByAgent.get(agent.id) ?? null,
  };
}

function leaderThreadOf(data: OrgData, projectId: string): ThreadSummary | null {
  return data.threads.find((t) => t.kind === "leader" && t.projectId === projectId) ?? null;
}

export async function buildSidebar(db: D1Database, userId: string | null, now: number): Promise<{ items: ProjectSidebarItem[]; approvals: number }> {
  const data = await loadOrgData(db, userId, now);
  const items: ProjectSidebarItem[] = [];
  for (const project of data.projects) {
    const leaderThread = leaderThreadOf(data, project.id);
    if (!leaderThread) continue;
    const counts = data.counts.get(project.id)!;
    const agents = project.agents.filter((a) => a.active);
    const lives = agents.map((a) => agentLive(a, data, a.role === "leader" ? leaderThread : null));
    const projectSessions = data.sessions.filter((s) => s.project_id === project.id && s.activity);
    const activity = projectSessions.sort((a, b) => b.updated_at - a.updated_at)[0]?.activity ?? leaderThread.activity ?? null;
    const lastActivityAt = data.lastActivityByProject.get(project.id) || null;
    items.push({
      project,
      counts,
      leaderThread,
      activeAgents: lives.filter((l) => l.state !== "idle").length,
      activity,
      lastActivityAt,
      inProgress: isProjectInProgress(counts) || leaderThread.status !== "idle",
    });
  }
  items.sort(compareSidebarProjects);
  return { items, approvals: data.approvals };
}

export async function buildOrg(db: D1Database, userId: string | null, now: number): Promise<OrgSnapshot> {
  const data = await loadOrgData(db, userId, now);
  const cooThread = data.threads.find((t) => t.kind === "coo")!;
  const coo = data.coo ?? { id: "agent-coo", projectId: null, role: "coo" as const, name: "COO", specialty: "", model: null, profile: null, active: true };
  const projects = data.projects.map((project) => {
    const leaderThread = leaderThreadOf(data, project.id);
    const active = project.agents.filter((a) => a.active);
    const leader = active.find((a) => a.role === "leader");
    return {
      project,
      counts: data.counts.get(project.id)!,
      leader: leader ? agentLive(leader, data, leaderThread) : null,
      members: active.filter((a) => a.role === "member").map((m) => agentLive(m, data, null)),
    };
  });
  const [quota, runner] = await Promise.all([getQuota(db), getRunnerStatus(db, now)]);
  return { coo: { ...agentLive(coo, data, cooThread), thread: cooThread }, projects, quota, runner };
}
