// ドメインの型と zod スキーマ（設計書 4.4）。D1 の列と 1 対 1 で対応させる。
import { z } from "zod";
import { INSTRUCTION_STATUSES } from "./status.ts";

export const InstructionStatusSchema = z.enum(INSTRUCTION_STATUSES);

export const TaskCountsSchema = z.object({
  total: z.int().min(0),
  done: z.int().min(0),
  running: z.int().min(0),
  failed: z.int().min(0),
});

export const InstructionSummarySchema = z.object({
  id: z.string(),
  clientId: z.string(),
  body: z.string(),
  title: z.string().nullable(),
  status: InstructionStatusSchema,
  statusChangedAt: z.number(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  resultSummary: z.string().nullable(),
  openDecisionId: z.string().nullable(),
  /** AI 枠切れなどで、この時刻まで取り出さない（時計アイコン用） */
  notBefore: z.number().nullable(),
  /** failed のときの理由（一覧でも出す） */
  error: z.string().nullable(),
  taskCounts: TaskCountsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
});
export type InstructionSummary = z.infer<typeof InstructionSummarySchema>;

export const TaskKindSchema = z.enum(["plan", "work", "review"]);
export const TaskStatusSchema = z.enum(["pending", "running", "done", "failed", "canceled"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  instructionId: z.string(),
  parentTaskId: z.string().nullable(),
  assigneeAgentId: z.string().nullable(),
  kind: TaskKindSchema,
  planKey: z.string().nullable(),
  dependsOn: z.array(z.string()),
  title: z.string(),
  spec: z.string(),
  status: TaskStatusSchema,
  resultSummary: z.string().nullable(),
  round: z.int(),
  seq: z.int(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const AgentRoleSchema = z.enum(["coo", "leader", "member"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  role: AgentRoleSchema,
  name: z.string(),
  specialty: z.string(),
  model: z.string().nullable(),
  active: z.boolean(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ProjectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);

export const ProjectWithTeamSchema = z.object({
  id: z.string(),
  slug: ProjectSlugSchema,
  name: z.string(),
  summary: z.string(),
  status: z.enum(["active", "archived"]),
  agents: z.array(AgentSchema),
  updatedAt: z.number(),
});
export type ProjectWithTeam = z.infer<typeof ProjectWithTeamSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  instructionId: z.string(),
  taskId: z.string().nullable(),
  askedByAgentId: z.string().nullable(),
  question: z.string(),
  options: z.array(z.string()),
  status: z.enum(["open", "answered", "canceled"]),
  answer: z.string().nullable(),
  answeredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ArtifactMetaSchema = z.object({
  id: z.string(),
  instructionId: z.string(),
  taskId: z.string().nullable(),
  projectSlug: z.string().nullable(),
  relPath: z.string(),
  title: z.string(),
  mime: z.string(),
  sizeBytes: z.int().min(0),
  createdAt: z.number(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

export const ArtifactSchema = ArtifactMetaSchema.extend({
  sha256: z.string(),
  previewText: z.string().nullable(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const AGENT_EVENT_KINDS = [
  "llm_call",
  "action",
  "tool_call",
  "tool_result",
  "summary",
  "decision",
  "note",
  "error",
] as const;
export const AgentEventKindSchema = z.enum(AGENT_EVENT_KINDS);
export type AgentEventKind = z.infer<typeof AgentEventKindSchema>;

export const AgentEventSchema = z.object({
  id: z.string(),
  instructionId: z.string(),
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  seq: z.int().min(0),
  kind: AgentEventKindSchema,
  content: z.unknown(),
  model: z.string().nullable(),
  tokensIn: z.int().nullable(),
  tokensOut: z.int().nullable(),
  durationMs: z.int().nullable(),
  createdAt: z.number(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const RunnerStatusSchema = z.object({
  online: z.boolean(),
  lastHeartbeatAt: z.number().nullable(),
  activeInstructionIds: z.array(z.string()),
  version: z.string().nullable(),
  tailnetUrl: z.string().nullable(),
});
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

export const BatonEnvSchema = z.enum(["production", "development", "e2e"]);
export type BatonEnv = z.infer<typeof BatonEnvSchema>;

export const SessionInfoSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    pictureUrl: z.string().nullable(),
  }),
  csrfToken: z.string(),
  runner: RunnerStatusSchema,
  env: BatonEnvSchema,
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const UsageTodaySchema = z.object({
  day: z.string(),
  tokensIn: z.int(),
  tokensOut: z.int(),
  byModel: z.array(z.object({ model: z.string(), tokensIn: z.int(), tokensOut: z.int() })),
  quotaHitAt: z.number().nullable(),
  /** 1 日あたりのトークン上限（UsageRing の分母） */
  dailyTokenLimit: z.int(),
});
export type UsageToday = z.infer<typeof UsageTodaySchema>;

export const InstructionDetailSchema = z.object({
  instruction: InstructionSummarySchema.extend({
    feedback: z.string().nullable(),
    tokensIn: z.int(),
    tokensOut: z.int(),
    attempt: z.int(),
  }),
  project: ProjectWithTeamSchema.nullable(),
  tasks: z.array(TaskSchema),
  decisions: z.array(DecisionSchema),
  artifacts: z.array(ArtifactMetaSchema),
  lastEventSeq: z.int(),
});
export type InstructionDetail = z.infer<typeof InstructionDetailSchema>;
