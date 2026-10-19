// ドメインの型と zod スキーマ（v1 設計書 4.4、DESIGN-v2 8・12.6）。D1 の列と 1 対 1 で対応させる。
// v2 で消したもの: AgentEvent（transcript_items へ）、UsageToday（サブスク枠 QuotaStatus へ）、指示の tokensIn/tokensOut。
import { z } from "zod";
import { AGENT_LIVE_STATES, INSTRUCTION_PHASES, INSTRUCTION_STATUSES, SESSION_STATUSES } from "./status.ts";
import { MEMBER_PROFILES } from "./structured-output.ts";

export const InstructionStatusSchema = z.enum(INSTRUCTION_STATUSES);
export const InstructionPhaseSchema = z.enum(INSTRUCTION_PHASES);

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
  /** 開いている判断の 1 つ（v1 互換。判断シートの既定） */
  openDecisionId: z.string().nullable(),
  /** 開いている判断（承認を含む）の数。1 以上なら running でも判断待ちのまとまり（displayGroup） */
  openDecisionCount: z.int().min(0),
  /** 動いているセッションの数 */
  activeSessionCount: z.int().min(0),
  /** いまの動き（1 行。例: 編集している src/a.ts） */
  activity: z.string().nullable(),
  /** 方針の版（4.6・D-79） */
  revision: z.int().min(1),
  phase: InstructionPhaseSchema.nullable(),
  /** CEO がこのプロジェクトのリーダーと話し中（COO の行動を保留している） */
  talkingWithCeo: z.boolean(),
  /** Claude Code の推定額の合計（USD。サブスクでは請求額ではない） */
  costUsdEst: z.number(),
  /** 枠切れなどで、この時刻まで取り出さない（時計アイコン用） */
  notBefore: z.number().nullable(),
  /** failed のときの理由（一覧でも出す） */
  error: z.string().nullable(),
  taskCounts: TaskCountsSchema,
  /** 動いているエージェントの頭文字（最大 3。13.8） */
  activeAgents: z.array(z.object({ agentId: z.string(), name: z.string(), role: z.enum(["coo", "leader", "member"]) })).max(3),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
});
export type InstructionSummary = z.infer<typeof InstructionSummarySchema>;

/** v2 の tasks は「メンバーの work タスク」。plan・review は v1 の互換で残す */
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
  /** 触ってよい範囲（リーダーの plan の paths） */
  paths: z.array(z.string()),
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
  /** 職種プロファイル（6.2）。null は役割の既定（coo / leader / generalist） */
  profile: z.string().nullable(),
  active: z.boolean(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const MemberProfileSchema = z.enum(MEMBER_PROFILES);

export const ProjectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);

export const WorkspaceKindSchema = z.enum(["baton", "repo"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const ProjectWithTeamSchema = z.object({
  id: z.string(),
  slug: ProjectSlugSchema,
  name: z.string(),
  summary: z.string(),
  /** 目的（COO との会話で固めたもの。3.1） */
  goal: z.string(),
  status: z.enum(["active", "archived"]),
  workspaceKind: WorkspaceKindSchema,
  repoPath: z.string().nullable(),
  /** 表示名（例: rikuhiromatsu/my-project）。repo のときだけ */
  repoName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  agents: z.array(AgentSchema),
  updatedAt: z.number(),
});
export type ProjectWithTeam = z.infer<typeof ProjectWithTeamSchema>;

export const DecisionKindSchema = z.enum(["question", "approval", "interrupted"]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;
export const VerdictSchema = z.enum(["allow", "deny"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  instructionId: z.string(),
  taskId: z.string().nullable(),
  askedByAgentId: z.string().nullable(),
  /** approval: 承認（道具の許可）、interrupted: 承認の時間切れ・中断からの再開、question: v1 の互換 */
  kind: DecisionKindSchema,
  sessionId: z.string().nullable(),
  question: z.string(),
  options: z.array(z.string()),
  toolName: z.string().nullable(),
  toolInput: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["open", "answered", "canceled"]),
  answer: z.string().nullable(),
  verdict: VerdictSchema.nullable(),
  /** 秘書 bot の回答案（決定は CEO。11.5） */
  suggestion: z.string().nullable(),
  suggestionVerdict: VerdictSchema.nullable(),
  suggestionAt: z.number().nullable(),
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

// ───────────── サブスク枠（9 章） ─────────────

const QuotaWindowSchema = z.object({ utilization: z.number().nullable(), resetsAt: z.number().nullable() });

export const QUOTA_STATES = ["allowed", "allowed_warning", "rejected", "unknown"] as const;
export const QuotaStatusSchema = z.object({
  observedAt: z.number().nullable(),
  fiveHour: QuotaWindowSchema,
  sevenDay: QuotaWindowSchema,
  status: z.enum(QUOTA_STATES),
  rejectedType: z.string().nullable(),
  /** UNIX ミリ秒。この時刻まで新しいターンを始めない */
  blockedUntil: z.number().nullable(),
  /** しきい値（5 時間枠 0.8・週 0.9）を超えてメンバーの起動を止めている */
  paused: z.boolean(),
});
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;

export const EMPTY_QUOTA: QuotaStatus = {
  observedAt: null,
  fiveHour: { utilization: null, resetsAt: null },
  sevenDay: { utilization: null, resetsAt: null },
  status: "unknown",
  rejectedType: null,
  blockedUntil: null,
  paused: false,
};

// ───────────── ランナー ─────────────

export const CLAUDE_AUTH_STATES = ["ok", "not_logged_in", "not_subscription", "unknown"] as const;
export const ClaudeAuthSchema = z.enum(CLAUDE_AUTH_STATES);
export type ClaudeAuth = z.infer<typeof ClaudeAuthSchema>;

export const RunnerStatusSchema = z.object({
  online: z.boolean(),
  lastHeartbeatAt: z.number().nullable(),
  activeInstructionIds: z.array(z.string()),
  activeSessionIds: z.array(z.string()),
  version: z.string().nullable(),
  tailnetUrl: z.string().nullable(),
  claudeVersion: z.string().nullable(),
  /** "ok" 以外は画面の点が橙（13.12） */
  claudeAuth: ClaudeAuthSchema,
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
  /** Web Push の applicationServerKey（base64url）。鍵が未登録なら null（10.3） */
  vapidPublicKey: z.string().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// ───────────── 会話（4 章） ─────────────

export const AUTHOR_KINDS = ["ceo", "coo", "leader", "member", "system", "secretary"] as const;
export const AuthorKindSchema = z.enum(AUTHOR_KINDS);
export type AuthorKind = z.infer<typeof AuthorKindSchema>;

export const ThreadKindSchema = z.enum(["coo", "leader"]);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;
export const ThreadStatusSchema = z.enum(["idle", "queued", "running"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

/** COO スレッドの固定 ID（0002 の初期データ） */
export const COO_THREAD_ID = "thread-coo";
export const COO_AGENT_ID = "agent-coo";

export const ThreadSummarySchema = z.object({
  id: z.string(),
  kind: ThreadKindSchema,
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  agentName: z.string(),
  status: ThreadStatusSchema,
  activity: z.string().nullable(),
  awaitingReply: z.boolean(),
  unread: z.int().min(0),
  lastMessage: z.object({ authorKind: AuthorKindSchema, preview: z.string(), createdAt: z.number() }).nullable(),
  talkingWithCeo: z.boolean(),
  lastSeq: z.int().min(0),
  lastReadSeq: z.int().min(0),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const THREAD_MESSAGE_KINDS = ["chat", "delegation", "report", "leader_report", "notice", "approval", "project_proposal"] as const;
export const ThreadMessageKindSchema = z.enum(THREAD_MESSAGE_KINDS);
export type ThreadMessageKind = z.infer<typeof ThreadMessageKindSchema>;
export const ThreadMessageStatusSchema = z.enum(["streaming", "complete", "failed", "canceled"]);
export type ThreadMessageStatus = z.infer<typeof ThreadMessageStatusSchema>;

/** 発言の ref（4.3）。知らない項目も残す */
export const MessageRefSchema = z.looseObject({
  fromSeq: z.int().optional(),
  toSeq: z.int().optional(),
  contextProjectId: z.string().optional(),
  proposalId: z.string().optional(),
  decisionId: z.string().optional(),
  threadId: z.string().optional(),
  revision: z.int().optional(),
  /** notice の種類（approve・send_back・cancel・retry・new_topic など） */
  notice: z.string().optional(),
});
export type MessageRef = z.infer<typeof MessageRefSchema>;

export const ThreadMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.int().min(0),
  authorKind: AuthorKindSchema,
  authorAgentId: z.string().nullable(),
  authorName: z.string().nullable(),
  kind: ThreadMessageKindSchema,
  body: z.string(),
  instructionId: z.string().nullable(),
  sessionId: z.string().nullable(),
  ref: MessageRefSchema,
  status: ThreadMessageStatusSchema,
  reaction: z.enum(["ack"]).nullable(),
  notify: z.boolean(),
  /** 発言のときの端末の冪等キー（CEO の発言だけ。楽観的送信の突き合わせ） */
  clientId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ProposalWorkspaceViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baton") }),
  z.object({ kind: z.literal("repo"), repoPath: z.string(), repoName: z.string() }),
]);

export const ProjectProposalSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  messageId: z.string().nullable(),
  status: z.enum(["pending", "accepted", "declined", "superseded"]),
  projectId: z.string().nullable(),
  name: z.string(),
  slug: ProjectSlugSchema,
  goal: z.string(),
  summary: z.string(),
  workspace: ProposalWorkspaceViewSchema,
  leader: z.object({ name: z.string(), specialty: z.string() }),
  members: z.array(z.object({ name: z.string(), specialty: z.string(), profile: MemberProfileSchema })),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type ProjectProposal = z.infer<typeof ProjectProposalSchema>;

// ───────────── セッションとトランスクリプト（5・8.3 章） ─────────────

export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export const SessionRoleSchema = z.enum(["coo", "leader", "member", "legacy"]);
export type SessionRole = z.infer<typeof SessionRoleSchema>;
export const PauseReasonSchema = z.enum(["question", "approval", "interrupted"]);

export const AgentSessionSummarySchema = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  instructionId: z.string().nullable(),
  agentId: z.string().nullable(),
  role: SessionRoleSchema,
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  model: z.string().nullable(),
  status: SessionStatusSchema,
  pauseReason: PauseReasonSchema.nullable(),
  activity: z.string().nullable(),
  activityAt: z.number().nullable(),
  turns: z.int().min(0),
  costUsdEst: z.number(),
  lastSeq: z.int().min(0),
  error: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  updatedAt: z.number(),
});
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;

export const TRANSCRIPT_ITEM_KINDS = [
  "user",
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "approval",
  "question",
  "denied",
  "output",
  "system",
  "result",
  "error",
  "legacy",
] as const;
export const TranscriptItemKindSchema = z.enum(TRANSCRIPT_ITEM_KINDS);
export type TranscriptItemKind = z.infer<typeof TranscriptItemKindSchema>;
export const TRANSCRIPT_AUTHORS = ["ceo", "runner", "claude", "system"] as const;
export const TranscriptAuthorSchema = z.enum(TRANSCRIPT_AUTHORS);
export type TranscriptAuthor = z.infer<typeof TranscriptAuthorSchema>;

export const TranscriptItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  threadId: z.string().nullable(),
  instructionId: z.string().nullable(),
  seq: z.int().min(0),
  kind: TranscriptItemKindSchema,
  author: TranscriptAuthorSchema,
  toolName: z.string().nullable(),
  toolUseId: z.string().nullable(),
  parentToolUseId: z.string().nullable(),
  summary: z.string(),
  body: z.record(z.string(), z.unknown()),
  truncated: z.boolean(),
  isError: z.boolean(),
  createdAt: z.number(),
});
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const SessionInputSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  sessionId: z.string(),
  instructionId: z.string(),
  body: z.string(),
  status: z.enum(["pending", "delivered", "canceled"]),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
});
export type SessionInput = z.infer<typeof SessionInputSchema>;

// ───────────── 作業場所（7 章） ─────────────

export const WorkspacePurposeSchema = z.enum(["integration", "task"]);
export const WorkspaceStatusSchema = z.enum(["active", "merged", "conflict", "kept", "removed", "failed"]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const DiffStatEntrySchema = z.object({
  path: z.string(),
  added: z.int().min(0),
  removed: z.int().min(0),
  change: z.enum(["A", "M", "D", "R"]),
});
export type DiffStatEntry = z.infer<typeof DiffStatEntrySchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  instructionId: z.string(),
  projectId: z.string(),
  purpose: WorkspacePurposeSchema,
  taskId: z.string().nullable(),
  parentId: z.string().nullable(),
  kind: WorkspaceKindSchema,
  repoPath: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  headSha: z.string().nullable(),
  status: WorkspaceStatusSchema,
  diffStat: z.array(DiffStatEntrySchema),
  diffTruncated: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  finalizedAt: z.number().nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** GET /api/instructions/:id/diff（13.7 の「変更」タブ） */
export const WorkspaceDiffSchema = z.object({
  workspace: WorkspaceSchema.nullable(),
  files: z.array(DiffStatEntrySchema),
  /** unified diff（先頭 200,000 文字） */
  patch: z.string().nullable(),
  truncated: z.boolean(),
  /** Codex の指摘の要約（あれば上に出す） */
  reviewSummary: z.string().nullable(),
});
export type WorkspaceDiff = z.infer<typeof WorkspaceDiffSchema>;

export const RepoCandidateSchema = z.object({
  path: z.string(),
  name: z.string(),
  defaultBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  lastCommitAt: z.number().nullable(),
  dirty: z.boolean(),
  /** 既に紐づいているプロジェクト */
  projectId: z.string().nullable(),
  seenAt: z.number(),
});
export type RepoCandidate = z.infer<typeof RepoCandidateSchema>;

// ───────────── サイドパネルと組織図（13.3・13.9） ─────────────

export const ProjectCountsSchema = z.object({
  running: z.int().min(0),
  queued: z.int().min(0),
  needsDecision: z.int().min(0),
  review: z.int().min(0),
  failed: z.int().min(0),
  doneRecent: z.int().min(0),
});
export type ProjectCounts = z.infer<typeof ProjectCountsSchema>;

export const ProjectSidebarItemSchema = z.object({
  project: ProjectWithTeamSchema,
  counts: ProjectCountsSchema,
  leaderThread: ThreadSummarySchema,
  activeAgents: z.int().min(0),
  activity: z.string().nullable(),
  lastActivityAt: z.number().nullable(),
  inProgress: z.boolean(),
});
export type ProjectSidebarItem = z.infer<typeof ProjectSidebarItemSchema>;

export const AgentLiveStateSchema = z.enum(AGENT_LIVE_STATES);

export const AgentLiveSchema = z.object({
  agent: AgentSchema,
  state: AgentLiveStateSchema,
  threadId: z.string().nullable(),
  work: z.array(
    z.object({
      sessionId: z.string(),
      instructionId: z.string().nullable(),
      title: z.string(),
      activity: z.string().nullable(),
      since: z.number(),
    }),
  ),
  lastActiveAt: z.number().nullable(),
  /** いま動いていないときに、ノードから開く直近のセッション（13.9 の「メンバー → そのセッションの詳細」） */
  lastWork: z.object({ sessionId: z.string(), instructionId: z.string() }).nullable().optional(),
});
export type AgentLive = z.infer<typeof AgentLiveSchema>;

export const OrgSnapshotSchema = z.object({
  coo: AgentLiveSchema.extend({ thread: ThreadSummarySchema }),
  projects: z.array(
    z.object({
      project: ProjectWithTeamSchema,
      counts: ProjectCountsSchema,
      leader: AgentLiveSchema.nullable(),
      members: z.array(AgentLiveSchema),
    }),
  ),
  quota: QuotaStatusSchema,
  runner: RunnerStatusSchema,
});
export type OrgSnapshot = z.infer<typeof OrgSnapshotSchema>;

// ───────────── プロファイル（6 章。見るだけ） ─────────────

export const ProfileViewSchema = z.object({
  id: z.string(),
  role: z.enum(["coo", "leader", "member"]),
  model: z.string(),
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  mcp: z.array(z.string()),
  codexReview: z.boolean(),
});
export type ProfileView = z.infer<typeof ProfileViewSchema>;

// ───────────── 通知（10 章） ─────────────

export const PushSubscriptionViewSchema = z.object({
  id: z.string(),
  deviceLabel: z.string(),
  /** endpoint のホスト（全文は出さない） */
  host: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  lastSuccessAt: z.number().nullable(),
});
export type PushSubscriptionView = z.infer<typeof PushSubscriptionViewSchema>;

// ───────────── 秘書 bot（11 章） ─────────────

export const BOT_SCOPES = ["read", "message", "propose"] as const;
export const BotScopeSchema = z.enum(BOT_SCOPES);
export type BotScope = z.infer<typeof BotScopeSchema>;

export const BotTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(BotScopeSchema),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});
export type BotTokenView = z.infer<typeof BotTokenViewSchema>;

export const BotAuditItemSchema = z.object({
  id: z.string(),
  tokenId: z.string(),
  via: z.enum(["mcp", "http"]),
  action: z.string(),
  target: z.string().nullable(),
  summary: z.string(),
  outcome: z.enum(["ok", "denied", "invalid", "rate_limited", "error"]),
  createdAt: z.number(),
});
export type BotAuditItem = z.infer<typeof BotAuditItemSchema>;

// ───────────── 指示の詳細（13.7） ─────────────

export const InstructionDetailSchema = z.object({
  instruction: InstructionSummarySchema.extend({
    feedback: z.string().nullable(),
    attempt: z.int(),
    originThreadId: z.string().nullable(),
    finalizedAt: z.number().nullable(),
  }),
  project: ProjectWithTeamSchema.nullable(),
  tasks: z.array(TaskSchema),
  decisions: z.array(DecisionSchema),
  /** 開いている判断（承認を含む。suggestion 付き） */
  openDecisions: z.array(DecisionSchema),
  artifacts: z.array(ArtifactMetaSchema),
  sessions: z.array(AgentSessionSummarySchema),
  workspaces: z.array(WorkspaceSchema),
  /** この指示が生まれた発言（COO の delegate の返事など） */
  originMessage: ThreadMessageSchema.nullable(),
  /** COO・リーダーのスレッド（タブ用） */
  cooThreadId: z.string(),
  leaderThreadId: z.string().nullable(),
});
export type InstructionDetail = z.infer<typeof InstructionDetailSchema>;
