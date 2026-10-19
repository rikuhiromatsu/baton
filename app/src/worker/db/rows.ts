// D1 の行の型と、行 → 契約の型への変換（設計書 3.2・4.4）
import type {
  Agent,
  AgentEvent,
  Artifact,
  ArtifactMeta,
  Decision,
  InstructionStatus,
  InstructionSummary,
  ProjectWithTeam,
  Task,
} from "@baton/shared";

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
};

/** 一覧用の結合済みの行（project_name・open_decision_id・タスク数） */
export type InstructionSummaryRow = InstructionRow & {
  project_name: string | null;
  open_decision_id: string | null;
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
};

export type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  summary: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
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

export type AgentEventRow = {
  id: string;
  instruction_id: string;
  task_id: string | null;
  agent_id: string | null;
  seq: number;
  kind: AgentEvent["kind"];
  content: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_ms: number | null;
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

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toSummary(r: InstructionSummaryRow): InstructionSummary {
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
    notBefore: r.not_before,
    error: r.error,
    taskCounts: {
      total: r.tc_total ?? 0,
      done: r.tc_done ?? 0,
      running: r.tc_running ?? 0,
      failed: r.tc_failed ?? 0,
    },
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
    active: r.active === 1,
  };
}

export function toProject(r: ProjectRow, agents: AgentRow[]): ProjectWithTeam {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    summary: r.summary,
    status: r.status,
    agents: agents.filter((a) => a.project_id === r.id).map(toAgent),
    updatedAt: r.updated_at,
  };
}

export function toDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    instructionId: r.instruction_id,
    taskId: r.task_id,
    askedByAgentId: r.asked_by_agent_id,
    question: r.question,
    options: parseJson<string[]>(r.options, []),
    status: r.status,
    answer: r.answer,
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

export function toAgentEvent(r: AgentEventRow): AgentEvent {
  return {
    id: r.id,
    instructionId: r.instruction_id,
    taskId: r.task_id,
    agentId: r.agent_id,
    seq: r.seq,
    kind: r.kind,
    content: parseJson<unknown>(r.content, null),
    model: r.model,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
}
