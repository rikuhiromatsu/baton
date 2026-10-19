// D1 の行の型と、行 → 契約の型への変換（v1 設計書 3.2・4.4、DESIGN-v2 8.2・12.6）
import type {
  Agent,
  AgentSessionSummary,
  Artifact,
  ArtifactMeta,
  BotAuditItem,
  BotScope,
  BotTokenView,
  ClaudeAuth,
  Decision,
  InstructionPhase,
  InstructionStatus,
  InstructionSummary,
  MemberProfile,
  ProjectProposal,
  ProjectWithTeam,
  PushSubscriptionView,
  RepoCandidate,
  SessionInput,
  Task,
  ThreadMessage,
  TranscriptItem,
  Workspace,
} from "@baton/shared";
import { parseJson, parseObject } from "../lib/json.ts";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  picture_url: string | null;
  created_at: number;
  last_login_at: number;
};

export type SessionRow = {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
};

export type RunnerRow = {
  id: string;
  name: string;
  token_hash: string;
  version: string | null;
  tailnet_url: string | null;
  last_heartbeat_at: number | null;
  status: string;
  revoked: number;
  created_at: number;
  quota: string;
  claude_version: string | null;
  claude_auth: ClaudeAuth;
};

export type InstructionRow = {
  id: string;
  client_id: string;
  created_by: string;
  body: string;
  title: string | null;
  status: InstructionStatus;
  status_changed_at: number;
  project_id: string | null;
  result_summary: string | null;
  feedback: string | null;
  error: string | null;
  attempt: number;
  lease_runner_id: string | null;
  lease_expires_at: number | null;
  not_before: number | null;
  tokens_in: number;
  tokens_out: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  origin_thread_id: string | null;
  origin_message_id: string | null;
  revision: number;
  phase: InstructionPhase | null;
  finalized_at: number | null;
  cost_usd_est: number;
};

/** 一覧用の結合済みの行 */
export type InstructionSummaryRow = InstructionRow & {
  project_name: string | null;
  open_decision_id: string | null;
  open_decision_count: number | null;
  active_session_count: number | null;
  session_activity: string | null;
  talking: number | null;
  tc_total: number | null;
  tc_done: number | null;
  tc_running: number | null;
  tc_failed: number | null;
};

export type TaskRow = {
  id: string;
  instruction_id: string;
  parent_task_id: string | null;
  project_id: string | null;
  assignee_agent_id: string | null;
  kind: Task["kind"];
  plan_key: string | null;
  depends_on: string;
  title: string;
  spec: string;
  status: Task["status"];
  result_summary: string | null;
  round: number;
  seq: number;
  attempt: number;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
  paths: string;
};

export type AgentRow = {
  id: string;
  project_id: string | null;
  role: Agent["role"];
  name: string;
  specialty: string;
  model: string | null;
  active: number;
  created_at: number;
  profile: string | null;
};

export type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  summary: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
  workspace_kind: "baton" | "repo";
  repo_path: string | null;
  base_branch: string | null;
  goal: string;
  /** runner_repos.name（結合したときだけ） */
  repo_name?: string | null;
};

export type DecisionRow = {
  id: string;
  instruction_id: string;
  task_id: string | null;
  asked_by_agent_id: string | null;
  question: string;
  options: string;
  status: Decision["status"];
  answer: string | null;
  answered_at: number | null;
  created_at: number;
  kind: Decision["kind"];
  session_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  verdict: "allow" | "deny" | null;
  suggestion: string | null;
  suggestion_verdict: "allow" | "deny" | null;
  suggestion_at: number | null;
};

export type ArtifactRow = {
  id: string;
  instruction_id: string;
  task_id: string | null;
  project_id: string | null;
  project_slug?: string | null;
  rel_path: string;
  title: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  preview_text: string | null;
  created_at: number;
};

export type TransitionRow = {
  id: string;
  instruction_id: string;
  from_status: InstructionStatus;
  to_status: InstructionStatus;
  action: string;
  actor: "ceo" | "runner" | "system";
  undone: number;
  created_at: number;
};

export type ThreadRow = {
  id: string;
  kind: "coo" | "leader";
  project_id: string | null;
  agent_id: string | null;
  current_session_id: string | null;
  status: "idle" | "queued" | "running";
  lease_runner_id: string | null;
  lease_expires_at: number | null;
  not_before: number | null;
  last_seq: number;
  last_message_at: number | null;
  awaiting_reply: number;
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  seq: number;
  client_id: string | null;
  author_kind: ThreadMessage["authorKind"];
  author_agent_id: string | null;
  kind: ThreadMessage["kind"];
  body: string;
  instruction_id: string | null;
  session_id: string | null;
  ref: string;
  status: ThreadMessage["status"];
  reaction: "ack" | null;
  notify: number;
  bot_token_id: string | null;
  created_at: number;
  updated_at: number;
  /** agents.name（結合したときだけ） */
  author_name?: string | null;
};

export type InboxRow = {
  id: string;
  thread_id: string;
  kind: string;
  wakes: number;
  message_id: string | null;
  instruction_id: string | null;
  payload: string;
  status: "pending" | "consumed" | "canceled";
  created_at: number;
  consumed_at: number | null;
};

export type ProposalRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  payload: string;
  status: ProjectProposal["status"];
  project_id: string | null;
  created_at: number;
  decided_at: number | null;
};

export type AgentSessionRow = {
  id: string;
  thread_id: string | null;
  instruction_id: string | null;
  agent_id: string | null;
  role: AgentSessionSummary["role"];
  project_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  title: string;
  cwd: string;
  model: string | null;
  status: AgentSessionSummary["status"];
  pause_reason: AgentSessionSummary["pauseReason"];
  activity: string | null;
  activity_at: number | null;
  turns: number;
  cost_usd_est: number;
  tokens_in: number;
  tokens_out: number;
  last_seq: number;
  claude_version: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
};

export type TranscriptRow = {
  id: string;
  session_id: string;
  thread_id: string | null;
  instruction_id: string | null;
  seq: number;
  kind: TranscriptItem["kind"];
  author: TranscriptItem["author"];
  tool_name: string | null;
  tool_use_id: string | null;
  parent_tool_use_id: string | null;
  summary: string;
  body: string;
  truncated: number;
  is_error: number;
  created_at: number;
};

export type SessionInputRow = {
  id: string;
  client_id: string;
  session_id: string;
  instruction_id: string;
  body: string;
  status: SessionInput["status"];
  created_by: string;
  created_at: number;
  delivered_at: number | null;
};

export type WorkspaceRow = {
  id: string;
  instruction_id: string;
  project_id: string;
  purpose: "integration" | "task";
  task_id: string | null;
  parent_id: string | null;
  kind: "baton" | "repo";
  repo_path: string;
  worktree_path: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  head_sha: string | null;
  status: Workspace["status"];
  diff_stat: string;
  diff_patch: string | null;
  diff_truncated: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
};

export type RepoRow = {
  path: string;
  runner_id: string;
  name: string;
  default_branch: string | null;
  head_sha: string | null;
  last_commit_at: number | null;
  dirty: number;
  seen_at: number;
  project_id?: string | null;
};

export type PushSubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string;
  enabled: number;
  failures: number;
  created_at: number;
  last_success_at: number | null;
};

export type BotTokenRow = {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type BotAuditRow = {
  id: string;
  token_id: string;
  via: "mcp" | "http";
  action: string;
  target: string | null;
  summary: string;
  outcome: BotAuditItem["outcome"];
  created_at: number;
};

// ───────────── 変換 ─────────────

export type ActiveAgentRef = InstructionSummary["activeAgents"][number];

export function toSummary(r: InstructionSummaryRow, activeAgents: ActiveAgentRef[] = []): InstructionSummary {
  return {
    id: r.id,
    clientId: r.client_id,
    body: r.body,
    title: r.title,
    status: r.status,
    statusChangedAt: r.status_changed_at,
    projectId: r.project_id,
    projectName: r.project_name,
    resultSummary: r.result_summary,
    openDecisionId: r.open_decision_id,
    openDecisionCount: r.open_decision_count ?? 0,
    activeSessionCount: r.active_session_count ?? 0,
    activity: r.session_activity ?? null,
    revision: r.revision,
    phase: r.phase,
    talkingWithCeo: (r.talking ?? 0) > 0,
    costUsdEst: r.cost_usd_est ?? 0,
    notBefore: r.not_before,
    error: r.error,
    taskCounts: {
      total: r.tc_total ?? 0,
      done: r.tc_done ?? 0,
      running: r.tc_running ?? 0,
      failed: r.tc_failed ?? 0,
    },
    activeAgents: activeAgents.slice(0, 3),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    instructionId: r.instruction_id,
    parentTaskId: r.parent_task_id,
    assigneeAgentId: r.assignee_agent_id,
    kind: r.kind,
    planKey: r.plan_key,
    dependsOn: parseJson<string[]>(r.depends_on, []),
    title: r.title,
    spec: r.spec,
    paths: parseJson<string[]>(r.paths, []),
    status: r.status,
    resultSummary: r.result_summary,
    round: r.round,
    seq: r.seq,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

export function toAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role,
    name: r.name,
    specialty: r.specialty,
    model: r.model,
    profile: r.profile,
    active: r.active === 1,
  };
}

/** リポジトリの表示名（候補に無ければパスの最後の 2 つ） */
export function repoDisplayName(path: string, known?: string | null): string {
  if (known) return known;
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

export function toProject(r: ProjectRow, agents: AgentRow[]): ProjectWithTeam {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    summary: r.summary,
    goal: r.goal ?? "",
    status: r.status,
    workspaceKind: r.workspace_kind,
    repoPath: r.repo_path,
    repoName: r.repo_path ? repoDisplayName(r.repo_path, r.repo_name) : null,
    baseBranch: r.base_branch,
    agents: agents.filter((a) => a.project_id === r.id).map(toAgent),
    updatedAt: r.updated_at,
  };
}

export function toDecision(r: DecisionRow): Decision {
  const toolInput = r.tool_input ? parseObject(r.tool_input) : null;
  return {
    id: r.id,
    instructionId: r.instruction_id,
    taskId: r.task_id,
    askedByAgentId: r.asked_by_agent_id,
    kind: r.kind,
    sessionId: r.session_id,
    question: r.question,
    options: parseJson<string[]>(r.options, []),
    toolName: r.tool_name,
    toolInput,
    status: r.status,
    answer: r.answer,
    verdict: r.verdict,
    suggestion: r.suggestion,
    suggestionVerdict: r.suggestion_verdict,
    suggestionAt: r.suggestion_at,
    answeredAt: r.answered_at,
    createdAt: r.created_at,
  };
}

export function toArtifactMeta(r: ArtifactRow): ArtifactMeta {
  return {
    id: r.id,
    instructionId: r.instruction_id,
    taskId: r.task_id,
    projectSlug: r.project_slug ?? null,
    relPath: r.rel_path,
    title: r.title,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  };
}

export function toArtifact(r: ArtifactRow): Artifact {
  return { ...toArtifactMeta(r), sha256: r.sha256, previewText: r.preview_text };
}

export function toMessage(r: MessageRow): ThreadMessage {
  return {
    id: r.id,
    threadId: r.thread_id,
    seq: r.seq,
    authorKind: r.author_kind,
    authorAgentId: r.author_agent_id,
    authorName: r.author_name ?? (r.author_kind === "ceo" ? "CEO" : r.author_kind === "secretary" ? "秘書" : null),
    kind: r.kind,
    body: r.body,
    instructionId: r.instruction_id,
    sessionId: r.session_id,
    ref: parseObject(r.ref),
    status: r.status,
    reaction: r.reaction,
    notify: r.notify === 1,
    clientId: r.client_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type ProposalPayload = {
  name: string;
  slug: string;
  goal: string;
  summary: string;
  workspace: { kind: "baton" } | { kind: "repo"; repoPath: string };
  leader: { name: string; specialty: string };
  members: { name: string; specialty: string; profile: MemberProfile }[];
};

export function proposalPayload(r: Pick<ProposalRow, "payload">): ProposalPayload {
  return parseJson<ProposalPayload>(r.payload, {
    name: "",
    slug: "invalid",
    goal: "",
    summary: "",
    workspace: { kind: "baton" },
    leader: { name: "", specialty: "" },
    members: [],
  });
}

export function toProposal(r: ProposalRow, repoNames: Map<string, string> = new Map()): ProjectProposal {
  const p = proposalPayload(r);
  return {
    id: r.id,
    threadId: r.thread_id,
    messageId: r.message_id,
    status: r.status,
    projectId: r.project_id,
    name: p.name,
    slug: p.slug,
    goal: p.goal,
    summary: p.summary,
    workspace:
      p.workspace.kind === "repo"
        ? { kind: "repo", repoPath: p.workspace.repoPath, repoName: repoDisplayName(p.workspace.repoPath, repoNames.get(p.workspace.repoPath)) }
        : { kind: "baton" },
    leader: p.leader,
    members: p.members,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export function toAgentSession(r: AgentSessionRow): AgentSessionSummary {
  return {
    id: r.id,
    threadId: r.thread_id,
    instructionId: r.instruction_id,
    agentId: r.agent_id,
    role: r.role,
    projectId: r.project_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    title: r.title,
    model: r.model,
    status: r.status,
    pauseReason: r.pause_reason,
    activity: r.activity,
    activityAt: r.activity_at,
    turns: r.turns,
    costUsdEst: r.cost_usd_est,
    lastSeq: r.last_seq,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at,
  };
}

export function toTranscriptItem(r: TranscriptRow): TranscriptItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    threadId: r.thread_id,
    instructionId: r.instruction_id,
    seq: r.seq,
    kind: r.kind,
    author: r.author,
    toolName: r.tool_name,
    toolUseId: r.tool_use_id,
    parentToolUseId: r.parent_tool_use_id,
    summary: r.summary,
    body: parseObject(r.body),
    truncated: r.truncated === 1,
    isError: r.is_error === 1,
    createdAt: r.created_at,
  };
}

export function toSessionInput(r: SessionInputRow): SessionInput {
  return {
    id: r.id,
    clientId: r.client_id,
    sessionId: r.session_id,
    instructionId: r.instruction_id,
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

export function toWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    instructionId: r.instruction_id,
    projectId: r.project_id,
    purpose: r.purpose,
    taskId: r.task_id,
    parentId: r.parent_id,
    kind: r.kind,
    repoPath: r.repo_path,
    worktreePath: r.worktree_path,
    branch: r.branch,
    baseRef: r.base_ref,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    status: r.status,
    diffStat: parseJson(r.diff_stat, []),
    diffTruncated: r.diff_truncated === 1,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finalizedAt: r.finalized_at,
  };
}

export function toRepo(r: RepoRow): RepoCandidate {
  return {
    path: r.path,
    name: r.name,
    defaultBranch: r.default_branch,
    headSha: r.head_sha,
    lastCommitAt: r.last_commit_at,
    dirty: r.dirty === 1,
    projectId: r.project_id ?? null,
    seenAt: r.seen_at,
  };
}

export function toPushSubscription(r: PushSubscriptionRow): PushSubscriptionView {
  let host = "";
  try {
    host = new URL(r.endpoint).host;
  } catch {
    host = "";
  }
  return {
    id: r.id,
    deviceLabel: r.device_label,
    host,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastSuccessAt: r.last_success_at,
  };
}

export function botScopes(r: Pick<BotTokenRow, "scopes">): BotScope[] {
  const v = parseJson<unknown>(r.scopes, []);
  return Array.isArray(v) ? (v.filter((s) => s === "read" || s === "message" || s === "propose") as BotScope[]) : [];
}

export function toBotToken(r: BotTokenRow): BotTokenView {
  return {
    id: r.id,
    name: r.name,
    scopes: botScopes(r),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}

export function toBotAudit(r: BotAuditRow): BotAuditItem {
  return {
    id: r.id,
    tokenId: r.token_id,
    via: r.via,
    action: r.action,
    target: r.target,
    summary: r.summary,
    outcome: r.outcome,
    createdAt: r.created_at,
  };
}
