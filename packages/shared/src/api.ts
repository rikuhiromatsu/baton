// API のパス・入出力スキーマ・エラー（設計書 4.1〜4.4）。
import { z } from "zod";
import { CEO_ACTIONS, INSTRUCTION_STATUSES } from "./status.ts";
import {
  AgentEventKindSchema,
  AgentEventSchema,
  AgentSchema,
  DecisionSchema,
  InstructionSummarySchema,
  ProjectSlugSchema,
  ProjectWithTeamSchema,
  TaskKindSchema,
  TaskSchema,
  TaskStatusSchema,
} from "./models.ts";
import { LIMITS } from "./limits.ts";

// ───────────── パス ─────────────

export const API_PATHS = {
  authLogin: "/api/auth/login",
  authCallback: "/api/auth/callback",
  authLogout: "/api/auth/logout",
  session: "/api/session",
  instructions: "/api/instructions",
  instruction: (id: string) => `/api/instructions/${id}`,
  instructionEvents: (id: string) => `/api/instructions/${id}/events`,
  instructionTransition: (id: string) => `/api/instructions/${id}/transition`,
  transitionUndo: (id: string) => `/api/transitions/${id}/undo`,
  decisionAnswer: (id: string) => `/api/decisions/${id}/answer`,
  projects: "/api/projects",
  artifact: (id: string) => `/api/artifacts/${id}`,
  usageToday: "/api/usage/today",
  ws: "/api/ws",

  runnerWs: "/api/runner/ws",
  runnerHeartbeat: "/api/runner/heartbeat",
  runnerClaim: "/api/runner/claim",
  runnerInstructionState: (id: string) => `/api/runner/instructions/${id}/state`,
  runnerInstruction: (id: string) => `/api/runner/instructions/${id}`,
  runnerRelease: (id: string) => `/api/runner/instructions/${id}/release`,
  runnerProjects: "/api/runner/projects",
  runnerProjectAgents: (id: string) => `/api/runner/projects/${id}/agents`,
  runnerTasks: "/api/runner/tasks",
  runnerTask: (id: string) => `/api/runner/tasks/${id}`,
  runnerEvents: "/api/runner/events",
  runnerArtifacts: "/api/runner/artifacts",
  runnerDecisions: "/api/runner/decisions",
  runnerAiChat: "/api/runner/ai/chat",

  /** e2e 環境だけ（設計書 6.5）。本番では 404 */
  testLogin: "/api/test/login",
  testRunnerToken: "/api/test/runner-token",
} as const;

export const CSRF_HEADER = "X-Baton-CSRF";
export const TEST_SECRET_HEADER = "X-Baton-Test-Secret";

// ───────────── エラー ─────────────

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "rate_limited",
  "ai_unavailable",
  "ai_quota",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  rate_limited: 429,
  ai_unavailable: 503,
  ai_quota: 429,
  internal: 500,
};

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ───────────── ブラウザ用 ─────────────

export const CreateInstructionInput = z.object({
  clientId: z.uuid(),
  body: z.string().trim().min(1).max(8000),
});
export type CreateInstructionInput = z.infer<typeof CreateInstructionInput>;

export const ListInstructionsQuery = z.object({
  view: z.enum(["active", "archived"]).default("active"),
  cursor: z.string().optional(),
});
export const ListInstructionsOutput = z.object({
  items: z.array(InstructionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListInstructionsOutput = z.infer<typeof ListInstructionsOutput>;

export const ListEventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
export const ListEventsOutput = z.object({ items: z.array(AgentEventSchema) });
export type ListEventsOutput = z.infer<typeof ListEventsOutput>;

export const TransitionInput = z.object({
  action: z.enum(CEO_ACTIONS),
  expectedStatus: z.enum(INSTRUCTION_STATUSES),
  comment: z.string().max(2000).optional(),
});
export type TransitionInput = z.infer<typeof TransitionInput>;

export const TransitionOutput = z.object({
  instruction: InstructionSummarySchema,
  transitionId: z.string(),
});
export type TransitionOutput = z.infer<typeof TransitionOutput>;

export const UndoOutput = z.object({ instruction: InstructionSummarySchema });
export type UndoOutput = z.infer<typeof UndoOutput>;

export const AnswerDecisionInput = z.object({
  answer: z.string().trim().min(1).max(2000),
  optionIndex: z.int().min(0).max(3).optional(),
});
export type AnswerDecisionInput = z.infer<typeof AnswerDecisionInput>;

export const AnswerDecisionOutput = z.object({
  decision: DecisionSchema,
  instruction: InstructionSummarySchema,
});
export type AnswerDecisionOutput = z.infer<typeof AnswerDecisionOutput>;

export const ListProjectsOutput = z.object({ items: z.array(ProjectWithTeamSchema) });
export type ListProjectsOutput = z.infer<typeof ListProjectsOutput>;

// ───────────── ランナー用 ─────────────

export const HeartbeatInput = z.object({
  version: z.string().max(40),
  tailnetUrl: z.url().nullable(),
  activeInstructionIds: z.array(z.uuid()).max(8),
  maxConcurrent: z.int().min(1).max(4),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

export const HeartbeatOutput = z.object({
  serverTime: z.number(),
  cancelInstructionIds: z.array(z.uuid()),
});
export type HeartbeatOutput = z.infer<typeof HeartbeatOutput>;

export const ClaimInput = z.object({
  maxConcurrent: z.int().min(1).max(4),
  activeIds: z.array(z.uuid()).max(8),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

export const ClaimedInstructionSchema = InstructionSummarySchema.extend({
  feedback: z.string().nullable(),
  attempt: z.int(),
});
export type ClaimedInstruction = z.infer<typeof ClaimedInstructionSchema>;

export const ClaimOutput = z.object({
  instruction: ClaimedInstructionSchema,
  /** 前回の実行の続きがある（タスクやイベントが既にある） */
  resume: z.boolean(),
});
export type ClaimOutput = z.infer<typeof ClaimOutput>;

export const RunnerInstructionState = z.object({
  instruction: ClaimedInstructionSchema,
  project: ProjectWithTeamSchema.nullable(),
  coo: AgentSchema,
  tasks: z.array(TaskSchema),
  /** 回答済み・未回答を含む判断 */
  decisions: z.array(DecisionSchema),
  /** 段階 1 の振り分けが記録済みか（kind=action かつ content.stage="route" のイベントがあるか） */
  routed: z.boolean(),
  /** 次に使うイベントの seq */
  nextEventSeq: z.int().min(0),
  /** 作業フォルダのファイル数など、ランナーが自分で持つものは含めない */
});
export type RunnerInstructionState = z.infer<typeof RunnerInstructionState>;

export const RunnerInstructionPatch = z.object({
  title: z.string().min(1).max(80).optional(),
  projectId: z.uuid().optional(),
  resultSummary: z.string().max(8000).optional(),
  status: z.enum(["review", "failed"]).optional(),
  error: z.string().max(4000).optional(),
});
export type RunnerInstructionPatch = z.infer<typeof RunnerInstructionPatch>;

export const ReleaseInput = z.object({
  reason: z.enum(["ai_quota", "ai_unavailable", "shutdown", "error"]),
  notBefore: z.number().nullable(),
  error: z.string().max(4000).optional(),
});
export type ReleaseInput = z.infer<typeof ReleaseInput>;

export const AgentSeedSchema = z.object({
  name: z.string().min(1).max(30),
  specialty: z.string().max(200),
});

export const CreateProjectInput = z.object({
  instructionId: z.uuid(),
  name: z.string().min(1).max(40),
  slug: ProjectSlugSchema,
  summary: z.string().max(400),
  leader: AgentSeedSchema,
  members: z.array(AgentSeedSchema).min(1).max(3),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const CreateAgentInput = AgentSeedSchema.extend({ role: z.literal("member") });
export const CreateAgentsInput = z.object({
  instructionId: z.uuid(),
  agents: z.array(CreateAgentInput).min(1).max(3),
});
export type CreateAgentsInput = z.infer<typeof CreateAgentsInput>;
export const CreateAgentsOutput = z.object({ items: z.array(AgentSchema) });

export const CreateTaskInput = z.object({
  /** ランナー側で採番してよい（再送の冪等性のため）。省略時は Worker が採番 */
  id: z.uuid().optional(),
  instructionId: z.uuid(),
  parentTaskId: z.uuid().nullable(),
  assigneeAgentId: z.string().nullable(),
  kind: TaskKindSchema,
  planKey: z.string().regex(/^t\d{1,2}$/).nullable(),
  dependsOn: z.array(z.string()).max(5),
  title: z.string().min(1).max(80),
  spec: z.string().max(2000),
  round: z.int().min(1).max(2),
  seq: z.int().min(0),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;
export const CreateTasksInput = z.object({ tasks: z.array(CreateTaskInput).min(1).max(LIMITS.tasksPerCreate) });
export type CreateTasksInput = z.infer<typeof CreateTasksInput>;
export const CreateTasksOutput = z.object({ items: z.array(TaskSchema) });

export const TaskPatch = z.object({
  status: TaskStatusSchema.optional(),
  resultSummary: z.string().max(4000).nullable().optional(),
  assigneeAgentId: z.string().nullable().optional(),
});
export type TaskPatch = z.infer<typeof TaskPatch>;

export const AppendEventInput = z.object({
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  seq: z.int().min(0),
  kind: AgentEventKindSchema,
  content: z.unknown(),
  model: z.string().nullable().optional(),
  tokensIn: z.int().nullable().optional(),
  tokensOut: z.int().nullable().optional(),
  durationMs: z.int().nullable().optional(),
});
export type AppendEventInput = z.infer<typeof AppendEventInput>;
export const AppendEventsInput = z.object({
  instructionId: z.uuid(),
  events: z.array(AppendEventInput).min(1).max(LIMITS.eventsPerAppend),
});
export type AppendEventsInput = z.infer<typeof AppendEventsInput>;
export const AppendEventsOutput = z.object({ lastSeq: z.int() });

export const CreateArtifactInput = z.object({
  instructionId: z.uuid(),
  taskId: z.string().nullable(),
  relPath: z.string().min(1).max(500),
  title: z.string().min(1).max(80),
  mime: z.string().max(100),
  sizeBytes: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  previewText: z.string().max(LIMITS.artifactPreviewMaxChars).nullable(),
});
export type CreateArtifactInput = z.infer<typeof CreateArtifactInput>;

export const CreateDecisionInput = z.object({
  instructionId: z.uuid(),
  taskId: z.string().nullable(),
  askedByAgentId: z.string().nullable(),
  question: z.string().min(1).max(1000),
  options: z.array(z.string().max(200)).max(4),
});
export type CreateDecisionInput = z.infer<typeof CreateDecisionInput>;

export const AI_ROLES = ["coo", "leader", "member", "util"] as const;
export type AiRole = (typeof AI_ROLES)[number];

export const AiChatInput = z.object({
  instructionId: z.uuid(),
  role: z.enum(AI_ROLES),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
    .min(1)
    .max(60),
  jsonSchema: z.object({ name: z.string(), schema: z.record(z.string(), z.unknown()) }).optional(),
  maxCompletionTokens: z.int().min(64).max(8192),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  /** 主モデルで JSON の検査に失敗したあとなど、最初から退避先を使う */
  preferFallback: z.boolean().optional(),
});
export type AiChatInput = z.infer<typeof AiChatInput>;

export const AiChatOutput = z.object({
  text: z.string(),
  model: z.string(),
  usedFallback: z.boolean(),
  usage: z.object({ tokensIn: z.int(), tokensOut: z.int() }),
});
export type AiChatOutput = z.infer<typeof AiChatOutput>;

// ───────────── テスト用（e2e のみ） ─────────────

export const TestLoginInput = z.object({ email: z.email(), name: z.string().optional() });
export const TestRunnerTokenOutput = z.object({ token: z.string(), runnerId: z.string() });

