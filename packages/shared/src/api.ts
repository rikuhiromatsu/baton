// API のパス・入出力スキーマ・エラー（v1 設計書 4.1〜4.4、DESIGN-v2 12 章）。
// v2 で消したもの（12.1）: POST /api/runner/ai/chat と AiChat*、ai_unavailable・ai_quota、GET /api/usage/today と UsageToday、
// POST /api/instructions（CEO が指示を直接作る）と CreateInstructionInput、v1 の claim・state・runner/projects、
// GET /api/instructions/:id/events と AgentEvent・AppendEvents。
import { z } from "zod";
import { CEO_ACTIONS, INSTRUCTION_PHASES, INSTRUCTION_STATUSES, SESSION_STATUSES } from "./status.ts";
import {
  AgentSessionSummarySchema,
  BotAuditItemSchema,
  BotScopeSchema,
  BotTokenViewSchema,
  ClaudeAuthSchema,
  DecisionSchema,
  DiffStatEntrySchema,
  InstructionSummarySchema,
  ProfileViewSchema,
  ProjectProposalSchema,
  ProjectSidebarItemSchema,
  ProjectSlugSchema,
  ProjectWithTeamSchema,
  PushSubscriptionViewSchema,
  QuotaStatusSchema,
  RepoCandidateSchema,
  SessionInputSchema,
  TaskKindSchema,
  TaskSchema,
  TaskStatusSchema,
  ThreadMessageKindSchema,
  ThreadMessageSchema,
  ThreadSummarySchema,
  TranscriptAuthorSchema,
  TranscriptItemKindSchema,
  TranscriptItemSchema,
  WorkspaceSchema,
  WorkspaceStatusSchema,
  MemberProfileSchema,
  MessageRefSchema,
  VerdictSchema,
  type ProjectWithTeam,
} from "./models.ts";
import { PlanTask, ProposalWorkspace } from "./structured-output.ts";
import { INBOX_KINDS } from "./turn-input.ts";
import { LIMITS } from "./limits.ts";

// ───────────── パス ─────────────

export const API_PATHS = {
  // 認証（v1）
  authLogin: "/api/auth/login",
  authCallback: "/api/auth/callback",
  authLogout: "/api/auth/logout",
  session: "/api/session",
  ws: "/api/ws",

  // 会話（12.2）
  threads: "/api/threads",
  threadMessages: (id: string) => `/api/threads/${id}/messages`,
  threadRead: (id: string) => `/api/threads/${id}/read`,
  threadLeave: (id: string) => `/api/threads/${id}/leave`,
  threadInterrupt: (id: string) => `/api/threads/${id}/interrupt`,
  threadReset: (id: string) => `/api/threads/${id}/reset`,
  proposalAccept: (id: string) => `/api/project-proposals/${id}/accept`,
  proposalDecline: (id: string) => `/api/project-proposals/${id}/decline`,

  // 指示（v1 ＋ 12.2）
  instructions: "/api/instructions",
  instruction: (id: string) => `/api/instructions/${id}`,
  instructionTransition: (id: string) => `/api/instructions/${id}/transition`,
  instructionDiff: (id: string) => `/api/instructions/${id}/diff`,
  transitionUndo: (id: string) => `/api/transitions/${id}/undo`,
  decisionAnswer: (id: string) => `/api/decisions/${id}/answer`,
  artifact: (id: string) => `/api/artifacts/${id}`,

  // セッションとトランスクリプト（12.2）
  sessionTranscript: (id: string) => `/api/sessions/${id}/transcript`,
  sessionMessages: (id: string) => `/api/sessions/${id}/messages`,
  sessionInterrupt: (id: string) => `/api/sessions/${id}/interrupt`,
  transcriptItem: (id: string) => `/api/transcript-items/${id}`,

  // 組織・プロジェクト（12.2）
  org: "/api/org",
  projectsSidebar: "/api/projects/sidebar",
  projects: "/api/projects",
  project: (id: string) => `/api/projects/${id}`,
  repos: "/api/repos",
  profiles: "/api/profiles",
  quota: "/api/quota",

  // 通知（10 章）
  pushSubscriptions: "/api/push/subscriptions",
  pushSubscription: (id: string) => `/api/push/subscriptions/${id}`,

  // 秘書のトークン（11.3）
  botTokens: "/api/bot-tokens",
  botToken: (id: string) => `/api/bot-tokens/${id}`,
  botTokenAudit: (id: string) => `/api/bot-tokens/${id}/audit`,

  // ランナー（12.3、Bearer）
  runnerWs: "/api/runner/ws",
  runnerHeartbeat: "/api/runner/heartbeat",
  runnerClaim: "/api/runner/claim",
  runnerThreadMessages: (id: string) => `/api/runner/threads/${id}/messages`,
  runnerThreadMessage: (id: string, mid: string) => `/api/runner/threads/${id}/messages/${mid}`,
  runnerThreadStream: (id: string) => `/api/runner/threads/${id}/stream`,
  runnerThreadInbox: (id: string) => `/api/runner/threads/${id}/inbox`,
  runnerThreadTurnDone: (id: string) => `/api/runner/threads/${id}/turn-done`,
  runnerThreadRelease: (id: string) => `/api/runner/threads/${id}/release`,
  runnerProjectProposals: "/api/runner/project-proposals",
  runnerProjects: "/api/runner/projects",
  runnerInstructions: "/api/runner/instructions",
  runnerInstruction: (id: string) => `/api/runner/instructions/${id}`,
  runnerInstructionRelease: (id: string) => `/api/runner/instructions/${id}/release`,
  runnerInstructionFinalized: (id: string) => `/api/runner/instructions/${id}/finalized`,
  runnerTasks: "/api/runner/tasks",
  runnerTask: (id: string) => `/api/runner/tasks/${id}`,
  runnerSessions: "/api/runner/sessions",
  runnerSession: (id: string) => `/api/runner/sessions/${id}`,
  runnerSessionInputs: (id: string) => `/api/runner/sessions/${id}/inputs`,
  runnerInputDelivered: (id: string) => `/api/runner/inputs/${id}/delivered`,
  runnerTranscript: "/api/runner/transcript",
  runnerApprovals: "/api/runner/approvals",
  runnerDecisions: "/api/runner/decisions",
  runnerArtifacts: "/api/runner/artifacts",
  runnerWorkspaces: "/api/runner/workspaces",
  runnerWorkspace: (id: string) => `/api/runner/workspaces/${id}`,
  runnerRepos: "/api/runner/repos",

  // 秘書 bot（12.4、Bearer の bot トークン）
  mcp: "/mcp",
  botOverview: "/api/bot/v1/overview",
  botProjects: "/api/bot/v1/projects",
  botProject: (id: string) => `/api/bot/v1/projects/${id}`,
  botWaiting: "/api/bot/v1/waiting",
  botInstruction: (id: string) => `/api/bot/v1/instructions/${id}`,
  botCooThread: "/api/bot/v1/coo-thread",
  botCooThreadMessages: "/api/bot/v1/coo-thread/messages",
  botProposals: "/api/bot/v1/proposals",
  botOpenApi: "/api/bot/v1/openapi.json",
} as const;

/**
 * e2e 環境だけ（v1 設計書 6.5）。本番では 404。
 * API_PATHS と分けてあるのは、本番の成果物に "/api/test/" の文字列を残さないため（assert-no-test-routes）。
 * Worker は test-only.ts（e2e ビルドでだけ読み込む）からしか参照しないこと。
 */
export const TEST_API_PATHS = {
  testLogin: "/api/test/login",
  testRunnerToken: "/api/test/runner-token",
} as const;

export const CSRF_HEADER = "X-Baton-CSRF";
export const TEST_SECRET_HEADER = "X-Baton-Test-Secret";

/** 秘書 bot のトークンの頭（11.3） */
export const BOT_TOKEN_PREFIX = "btn_bot_";

// ───────────── エラー ─────────────

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "rate_limited",
  /** 指示の版が古い（4.6・D-79。ランナーの expectedRevision） */
  "stale_revision",
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
  stale_revision: 409,
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

// ───────────── ブラウザ用: 会話（12.2） ─────────────

export const ListThreadsOutput = z.object({ items: z.array(ThreadSummarySchema) });
export type ListThreadsOutput = z.infer<typeof ListThreadsOutput>;

export const ListMessagesQuery = z.object({
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.messagesPage).default(LIMITS.messagesPage),
});
export const ListMessagesOutput = z.object({ items: z.array(ThreadMessageSchema), hasMoreBefore: z.boolean() });
export type ListMessagesOutput = z.infer<typeof ListMessagesOutput>;

export const PostMessageInput = z.object({
  clientId: z.uuid(),
  body: z.string().trim().min(1).max(LIMITS.ceoMessageMaxChars),
  contextProjectId: z.string().optional(),
  instructionId: z.string().optional(),
});
export type PostMessageInput = z.infer<typeof PostMessageInput>;
export const PostMessageOutput = z.object({ message: ThreadMessageSchema });
export type PostMessageOutput = z.infer<typeof PostMessageOutput>;

export const ReadThreadInput = z.object({ seq: z.int().min(0) });
export type ReadThreadInput = z.infer<typeof ReadThreadInput>;

export const ResetThreadOutput = z.object({ message: ThreadMessageSchema });

export const AcceptProposalInput = z.object({
  workspace: z.discriminatedUnion("kind", [z.object({ kind: z.literal("baton") }), z.object({ kind: z.literal("repo"), repoPath: z.string().min(1) })]).optional(),
});
export type AcceptProposalInput = z.infer<typeof AcceptProposalInput>;
export const AcceptProposalOutput = z.object({ project: ProjectWithTeamSchema, proposal: ProjectProposalSchema });
export type AcceptProposalOutput = z.infer<typeof AcceptProposalOutput>;

// ───────────── ブラウザ用: 指示 ─────────────

export const ListInstructionsQuery = z.object({
  view: z.enum(["active", "archived"]).default("active"),
  projectId: z.string().optional(),
  cursor: z.string().optional(),
});
export const ListInstructionsOutput = z.object({
  items: z.array(InstructionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListInstructionsOutput = z.infer<typeof ListInstructionsOutput>;

export const TransitionInput = z.object({
  action: z.enum(CEO_ACTIONS),
  expectedStatus: z.enum(INSTRUCTION_STATUSES),
  /** send_back のコメントは COO スレッドに CEO の発言として入る（4.4） */
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

/** 承認（verdict）・中断の再開・v1 の質問（answer）。承認は verdict 必須（Worker が検査） */
export const AnswerDecisionInput = z
  .object({
    answer: z.string().trim().min(1).max(2000).optional(),
    optionIndex: z.int().min(0).max(3).optional(),
    verdict: VerdictSchema.optional(),
  })
  .refine((v) => v.answer !== undefined || v.verdict !== undefined, { message: "answer か verdict が要ります" });
export type AnswerDecisionInput = z.infer<typeof AnswerDecisionInput>;

export const AnswerDecisionOutput = z.object({
  decision: DecisionSchema,
  instruction: InstructionSummarySchema,
});
export type AnswerDecisionOutput = z.infer<typeof AnswerDecisionOutput>;

// ───────────── ブラウザ用: セッション ─────────────

export const TranscriptQuery = z.object({
  after: z.coerce.number().int().min(-1).optional(),
  before: z.coerce.number().int().min(0).optional(),
  instructionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.transcriptPage).default(LIMITS.transcriptPage),
});
export const TranscriptOutput = z.object({ items: z.array(TranscriptItemSchema), hasMoreBefore: z.boolean() });
export type TranscriptOutput = z.infer<typeof TranscriptOutput>;

export const PostSessionMessageInput = z.object({
  clientId: z.uuid(),
  body: z.string().trim().min(1).max(LIMITS.ceoMessageMaxChars),
});
export type PostSessionMessageInput = z.infer<typeof PostSessionMessageInput>;
export const PostSessionMessageOutput = z.object({ input: SessionInputSchema });

// ───────────── ブラウザ用: 組織・プロジェクト ─────────────

export const SidebarOutput = z.object({
  items: z.array(ProjectSidebarItemSchema),
  /** 承認待ちの数（サイドパネルの紫の行） */
  approvals: z.int().min(0),
});
export type SidebarOutput = z.infer<typeof SidebarOutput>;

export const ListProjectsOutput = z.object({ items: z.array(ProjectWithTeamSchema) });
export type ListProjectsOutput = z.infer<typeof ListProjectsOutput>;

/** 作業場所の変更は動いている指示が無いときだけ（Worker が検査）。repoPath は候補にあるものだけ。null で紐づけを外す */
export const PatchProjectInput = z.object({
  repoPath: z.string().min(1).nullable().optional(),
  baseBranch: z.string().min(1).max(200).nullable().optional(),
  goal: z.string().max(400).optional(),
});
export type PatchProjectInput = z.infer<typeof PatchProjectInput>;

/** 組織図の「リポジトリから作る」（プロジェクト案を作り COO に知らせる） */
export const CreateProjectFromRepoInput = z.object({ repoPath: z.string().min(1) });
export type CreateProjectFromRepoInput = z.infer<typeof CreateProjectFromRepoInput>;
export const CreateProjectFromRepoOutput = z.object({ proposal: ProjectProposalSchema });

export const ListReposOutput = z.object({ items: z.array(RepoCandidateSchema) });
export type ListReposOutput = z.infer<typeof ListReposOutput>;

export const ListProfilesOutput = z.object({ items: z.array(ProfileViewSchema) });
export type ListProfilesOutput = z.infer<typeof ListProfilesOutput>;

export const QuotaOutput = QuotaStatusSchema.extend({ estimatedCostTodayUsd: z.number() });
export type QuotaOutput = z.infer<typeof QuotaOutput>;

// ───────────── ブラウザ用: 通知（10 章） ─────────────

/** 送り先のホスト（SSRF 対策。10.3）。e2e だけ localhost を足す */
export const PUSH_ALLOWED_HOST_PATTERNS: readonly RegExp[] = [
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/,
];
export const PUSH_E2E_ALLOWED_ORIGIN = "http://localhost:8799";

/** 購読の endpoint が送り先として許されるか（https で許可ホスト。e2e は偽のプッシュサービスも） */
export function isAllowedPushEndpoint(endpoint: string, opts: { allowE2E?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (opts.allowE2E && url.origin === PUSH_E2E_ALLOWED_ORIGIN && url.pathname.startsWith("/push/")) return true;
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  return PUSH_ALLOWED_HOST_PATTERNS.some((re) => re.test(url.hostname));
}

export const CreatePushSubscriptionInput = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  deviceLabel: z.string().max(60).default(""),
});
export type CreatePushSubscriptionInput = z.infer<typeof CreatePushSubscriptionInput>;
export const ListPushSubscriptionsOutput = z.object({ items: z.array(PushSubscriptionViewSchema) });

/** 通知の中身（暗号化して送る。3KB 以内。10.2） */
export const PushPayloadSchema = z.object({
  title: z.string().max(60),
  body: z.string().max(200),
  url: z.string().startsWith("/"),
  tag: z.string().max(100),
  unread: z.int().min(0),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

// ───────────── ブラウザ用: 秘書のトークン（11.3） ─────────────

export const ListBotTokensOutput = z.object({ items: z.array(BotTokenViewSchema) });
export const CreateBotTokenInput = z.object({
  name: z.string().trim().min(1).max(40),
  scopes: z.array(BotScopeSchema).min(1).max(3),
});
export type CreateBotTokenInput = z.infer<typeof CreateBotTokenInput>;
/** token はこの応答で 1 回だけ返す */
export const CreateBotTokenOutput = z.object({ token: z.string().startsWith(BOT_TOKEN_PREFIX), item: BotTokenViewSchema });
export type CreateBotTokenOutput = z.infer<typeof CreateBotTokenOutput>;
export const BotAuditQuery = z.object({ cursor: z.string().optional() });
export const BotAuditOutput = z.object({ items: z.array(BotAuditItemSchema), nextCursor: z.string().nullable() });

// ───────────── ランナー用（12.3） ─────────────

export const HeartbeatInput = z.object({
  version: z.string().max(40),
  tailnetUrl: z.url().nullable(),
  activeInstructionIds: z.array(z.string()).max(16),
  activeSessionIds: z.array(z.string()).max(16),
  activeThreadIds: z.array(z.string()).max(16),
  quota: QuotaStatusSchema,
  claudeVersion: z.string().max(40).nullable(),
  claudeAuth: ClaudeAuthSchema,
  profiles: z.array(ProfileViewSchema).max(20),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

export const HeartbeatOutput = z.object({
  serverTime: z.number(),
  cancelInstructionIds: z.array(z.string()),
  interruptSessionIds: z.array(z.string()),
  interruptThreadIds: z.array(z.string()),
});
export type HeartbeatOutput = z.infer<typeof HeartbeatOutput>;

export const ClaimInput = z.object({
  /** いま動かせる種類（プロセスの空き。5.8） */
  kinds: z.array(z.enum(["thread", "instruction", "finalize"])).min(1),
  activeThreadIds: z.array(z.string()).max(16),
  activeInstructionIds: z.array(z.string()).max(16),
  /** 枠でメンバーの起動を止めている（9.2） */
  quotaPaused: z.boolean(),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** 受信箱の 1 件（turn-input.ts の InboxEntry ＋ ID） */
export const InboxItemSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  kind: z.enum(INBOX_KINDS),
  wakes: z.boolean(),
  messageId: z.string().nullable(),
  instructionId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const ClaimThreadSchema = z.object({
  id: z.string(),
  kind: z.enum(["coo", "leader"]),
  projectId: z.string().nullable(),
  agentId: z.string().nullable(),
  currentSessionId: z.string().nullable(),
  /** 現在のセッションの num_turns の合計（400 を超えたら新しいセッション。4.2） */
  sessionTurns: z.int().min(0),
  lastSeq: z.int().min(0),
});

export const OpenInstructionStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(INSTRUCTION_STATUSES),
  phase: z.enum(INSTRUCTION_PHASES).nullable(),
  revision: z.int().min(1),
  projectId: z.string().nullable(),
  talkingWithCeo: z.boolean(),
});
export type OpenInstructionState = z.infer<typeof OpenInstructionStateSchema>;

export const ThreadTurnContextSchema = z.object({
  recentMessages: z.array(ThreadMessageSchema),
  openInstructions: z.array(OpenInstructionStateSchema),
  projects: z.array(ProjectWithTeamSchema),
  repos: z.array(RepoCandidateSchema),
  /** CEO がリーダーと話し中のプロジェクト（COO の present・relay を保留。D-79） */
  talkingProjectIds: z.array(z.string()),
  /** CEO が見ている画面の説明（[文脈]） */
  viewing: z.string().nullable(),
});
export type ThreadTurnContext = z.infer<typeof ThreadTurnContextSchema>;

export const ClaimInstructionSchema = InstructionSummarySchema.extend({
  feedback: z.string().nullable(),
  attempt: z.int(),
  originThreadId: z.string().nullable(),
});

export const ClaimOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread: ClaimThreadSchema, inbox: z.array(InboxItemSchema), context: ThreadTurnContextSchema }),
  z.object({
    kind: z.literal("instruction"),
    instruction: ClaimInstructionSchema,
    tasks: z.array(TaskSchema),
    workspaces: z.array(WorkspaceSchema),
    sessions: z.array(AgentSessionSummarySchema),
    project: ProjectWithTeamSchema,
  }),
  z.object({ kind: z.literal("finalize"), instruction: ClaimInstructionSchema, workspaces: z.array(WorkspaceSchema), project: ProjectWithTeamSchema }),
]);
export type ClaimOutput = z.infer<typeof ClaimOutput>;

/** エージェント・システムの発言（POST /api/runner/threads/:id/messages） */
export const RunnerPostMessageInput = z.object({
  /** ランナーが採番（冪等） */
  id: z.uuid(),
  authorKind: z.enum(["coo", "leader", "system"]),
  authorAgentId: z.string().nullable(),
  kind: ThreadMessageKindSchema,
  body: z.string().max(LIMITS.messageBodyMaxChars),
  instructionId: z.string().nullable(),
  sessionId: z.string().nullable(),
  ref: MessageRefSchema.default({}),
  status: z.enum(["streaming", "complete"]),
  notify: z.boolean(),
});
export type RunnerPostMessageInput = z.infer<typeof RunnerPostMessageInput>;
export const RunnerPostMessageOutput = z.object({ message: ThreadMessageSchema });

export const RunnerPatchMessageInput = z.object({
  body: z.string().max(LIMITS.messageBodyMaxChars).optional(),
  kind: ThreadMessageKindSchema.optional(),
  status: z.enum(["complete", "failed", "canceled"]).optional(),
  instructionId: z.string().nullable().optional(),
  ref: MessageRefSchema.optional(),
  notify: z.boolean().optional(),
  /** 本文も行動も無かった（空の発言を消す。4.7） */
  delete: z.boolean().optional(),
});
export type RunnerPatchMessageInput = z.infer<typeof RunnerPatchMessageInput>;

/** ストリームの差分（D1 に書かない。4.7） */
export const StreamInput = z.object({
  messageId: z.string(),
  /** 継ぎ足す位置（それまでの文字数） */
  offset: z.int().min(0),
  delta: z.string().max(LIMITS.streamDeltaMaxChars),
  /** それまでの文章を前置きとして外す */
  reset: z.boolean().optional(),
  /** いまの動き（「読んでいる org.md」） */
  activity: z.string().max(LIMITS.summaryMaxChars).nullable().optional(),
});
export type StreamInput = z.infer<typeof StreamInput>;

export const RunnerInboxInput = z.object({
  kind: z.enum(INBOX_KINDS),
  wakes: z.boolean(),
  messageId: z.string().nullable().optional(),
  instructionId: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RunnerInboxInput = z.infer<typeof RunnerInboxInput>;

export const TurnDoneInput = z.object({
  consumedInboxIds: z.array(z.string()).max(200),
  awaitingReply: z.boolean(),
  /** 相づちに ack を付ける CEO の発言（D-77） */
  ackMessageIds: z.array(z.string()).max(50),
  sessionId: z.string(),
  /** このターンで足した num_turns（セッションの切り替えの判断用） */
  numTurns: z.int().min(0).default(0),
});
export type TurnDoneInput = z.infer<typeof TurnDoneInput>;

export const ThreadReleaseInput = z.object({
  reason: z.enum(["quota", "shutdown", "error", "auth"]),
  notBefore: z.number().nullable(),
  error: z.string().max(4000).optional(),
});
export type ThreadReleaseInput = z.infer<typeof ThreadReleaseInput>;

/** propose_project（repoPath は候補にあるものだけ。無ければランナーが baton に直す） */
export const RunnerCreateProposalInput = z.object({
  id: z.uuid(),
  threadId: z.string(),
  messageId: z.string().nullable(),
  name: z.string().min(1).max(40),
  slug: ProjectSlugSchema,
  goal: z.string().min(1).max(400),
  summary: z.string().max(400),
  workspace: ProposalWorkspace,
  leader: z.object({ name: z.string().min(1).max(30), specialty: z.string().max(200) }),
  members: z.array(z.object({ name: z.string().min(1).max(30), specialty: z.string().max(200), profile: MemberProfileSchema })).min(1).max(3),
});
export type RunnerCreateProposalInput = z.infer<typeof RunnerCreateProposalInput>;

/** delegate の new（Baton 専用だけ。D-51） */
export const RunnerCreateProjectInput = z.object({
  name: z.string().min(1).max(40),
  slug: ProjectSlugSchema,
  goal: z.string().min(1).max(400),
  summary: z.string().max(400),
  leader: z.object({ name: z.string().min(1).max(30), specialty: z.string().max(200) }),
  members: z.array(z.object({ name: z.string().min(1).max(30), specialty: z.string().max(200), profile: MemberProfileSchema })).min(1).max(3),
});
export type RunnerCreateProjectInput = z.infer<typeof RunnerCreateProjectInput>;
export const RunnerCreateProjectOutput = z.object({ project: ProjectWithTeamSchema, leaderThreadId: z.string() });

/** 指示の作成（冪等。COO の delegate、リーダーの plan の instructionId: null） */
export const RunnerCreateInstructionInput = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(60),
  body: z.string().min(1).max(8000),
  projectId: z.string(),
  originThreadId: z.string(),
  originMessageId: z.string().nullable(),
  phase: z.enum(INSTRUCTION_PHASES).default("leader"),
});
export type RunnerCreateInstructionInput = z.infer<typeof RunnerCreateInstructionInput>;

export const RunnerInstructionPatch = z.object({
  title: z.string().min(1).max(80).optional(),
  status: z.enum(["queued", "running", "needs_decision", "review", "failed"]).optional(),
  phase: z.enum(INSTRUCTION_PHASES).nullable().optional(),
  resultSummary: z.string().max(12000).optional(),
  /** reopen（review/done → running） */
  reopen: z.boolean().optional(),
  revisionBump: z.boolean().optional(),
  /** COO の present・relay の版の検査。合わなければ 409 stale_revision */
  expectedRevision: z.int().min(1).optional(),
  costUsdDelta: z.number().min(0).optional(),
  error: z.string().max(4000).optional(),
});
export type RunnerInstructionPatch = z.infer<typeof RunnerInstructionPatch>;

export const InstructionReleaseInput = z.object({
  reason: z.enum(["quota", "shutdown", "error", "auth"]),
  notBefore: z.number().nullable(),
  error: z.string().max(4000).optional(),
});
export type InstructionReleaseInput = z.infer<typeof InstructionReleaseInput>;

export const CreateTaskInput = z.object({
  /** ランナー側で採番してよい（再送の冪等性のため）。省略時は Worker が採番 */
  id: z.uuid().optional(),
  instructionId: z.string(),
  parentTaskId: z.string().nullable(),
  assigneeAgentId: z.string().nullable(),
  kind: TaskKindSchema,
  planKey: PlanTask.shape.key.nullable(),
  dependsOn: z.array(z.string()).max(5),
  title: z.string().min(1).max(80),
  spec: z.string().max(2000),
  paths: PlanTask.shape.paths,
  round: z.int().min(1).max(LIMITS.maxRounds),
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

export const CreateSessionInput = z.object({
  /** ランナーが crypto.randomUUID() で採番し --session-id に渡す（D-44） */
  id: z.uuid(),
  threadId: z.string().nullable(),
  instructionId: z.string().nullable(),
  agentId: z.string().nullable(),
  role: z.enum(["coo", "leader", "member"]),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  title: z.string().max(60),
  cwd: z.string().max(1000),
  model: z.string().max(60).nullable(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

export const SessionPatch = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  pauseReason: z.enum(["question", "approval", "interrupted"]).nullable().optional(),
  activity: z.string().max(LIMITS.summaryMaxChars).nullable().optional(),
  turnsDelta: z.int().min(0).optional(),
  costUsdDelta: z.number().min(0).optional(),
  tokensInDelta: z.int().min(0).optional(),
  tokensOutDelta: z.int().min(0).optional(),
  claudeVersion: z.string().max(40).optional(),
  error: z.string().max(4000).nullable().optional(),
  started: z.boolean().optional(),
  ended: z.boolean().optional(),
});
export type SessionPatch = z.infer<typeof SessionPatch>;
export const SessionOutput = z.object({ session: AgentSessionSummarySchema });

export const AppendTranscriptItemInput = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  threadId: z.string().nullable(),
  instructionId: z.string().nullable(),
  seq: z.int().min(0),
  kind: TranscriptItemKindSchema,
  author: TranscriptAuthorSchema,
  toolName: z.string().max(100).nullable(),
  toolUseId: z.string().max(100).nullable(),
  parentToolUseId: z.string().max(100).nullable(),
  summary: z.string().max(LIMITS.summaryMaxChars),
  body: z.record(z.string(), z.unknown()),
  truncated: z.boolean(),
  isError: z.boolean(),
  createdAt: z.number(),
});
export type AppendTranscriptItemInput = z.infer<typeof AppendTranscriptItemInput>;
export const AppendTranscriptInput = z.object({ items: z.array(AppendTranscriptItemInput).min(1).max(LIMITS.transcriptPerPost) });
export type AppendTranscriptInput = z.infer<typeof AppendTranscriptInput>;
export const AppendTranscriptOutput = z.object({ accepted: z.int().min(0), lastSeqBySession: z.record(z.string(), z.int()) });

export const PendingInputsOutput = z.object({ items: z.array(SessionInputSchema) });

/** 承認の依頼（can_use_tool → 方針で「聞く」になったもの。7.6） */
export const CreateApprovalInput = z.object({
  id: z.uuid(),
  instructionId: z.string(),
  sessionId: z.string(),
  taskId: z.string().nullable(),
  askedByAgentId: z.string().nullable(),
  toolName: z.string().max(100),
  toolInput: z.record(z.string(), z.unknown()),
  toolUseId: z.string().max(100).nullable(),
  question: z.string().min(1).max(1000),
});
export type CreateApprovalInput = z.infer<typeof CreateApprovalInput>;

/** 判断（中断からの再開 interrupted、v1 の question） */
export const CreateDecisionInput = z.object({
  id: z.uuid().optional(),
  instructionId: z.string(),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  askedByAgentId: z.string().nullable(),
  kind: z.enum(["question", "interrupted"]),
  question: z.string().min(1).max(1000),
  options: z.array(z.string().max(200)).max(4).default([]),
  /** 承認の時間切れで落としたとき、元の承認（判断に引き継ぐ） */
  fromApprovalId: z.string().nullable().optional(),
});
export type CreateDecisionInput = z.infer<typeof CreateDecisionInput>;

export const CreateArtifactInput = z.object({
  instructionId: z.string(),
  taskId: z.string().nullable(),
  relPath: z.string().min(1).max(500),
  title: z.string().min(1).max(80),
  mime: z.string().max(100),
  sizeBytes: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  previewText: z.string().max(LIMITS.artifactPreviewMaxChars).nullable(),
});
export type CreateArtifactInput = z.infer<typeof CreateArtifactInput>;

export const CreateWorkspaceInput = z.object({
  id: z.uuid(),
  instructionId: z.string(),
  projectId: z.string(),
  purpose: z.enum(["integration", "task"]),
  taskId: z.string().nullable(),
  parentId: z.string().nullable(),
  kind: z.enum(["baton", "repo"]),
  repoPath: z.string().max(1000),
  worktreePath: z.string().max(1000),
  branch: z.string().max(200),
  baseRef: z.string().max(200),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;

export const WorkspacePatch = z.object({
  status: WorkspaceStatusSchema.optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
  diffStat: z.array(DiffStatEntrySchema).max(2000).optional(),
  diffPatch: z.string().max(LIMITS.diffPatchMaxChars).nullable().optional(),
  diffTruncated: z.boolean().optional(),
  error: z.string().max(4000).nullable().optional(),
  finalized: z.boolean().optional(),
});
export type WorkspacePatch = z.infer<typeof WorkspacePatch>;
export const ListWorkspacesQuery = z.object({ status: z.string().optional(), instructionId: z.string().optional() });
export const ListWorkspacesOutput = z.object({ items: z.array(WorkspaceSchema) });

export const PutReposInput = z.object({
  items: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        name: z.string().min(1).max(200),
        defaultBranch: z.string().max(200).nullable(),
        headSha: z.string().max(40).nullable(),
        lastCommitAt: z.number().nullable(),
        dirty: z.boolean(),
      }),
    )
    .max(500),
});
export type PutReposInput = z.infer<typeof PutReposInput>;

export const FinalizedInput = z.object({
  outcome: z.enum(["merged", "kept", "conflict", "removed", "failed"]),
  branch: z.string().max(200).nullable(),
  error: z.string().max(4000).nullable().optional(),
});
export type FinalizedInput = z.infer<typeof FinalizedInput>;

// ───────────── テスト用（e2e のみ） ─────────────

export const TestLoginInput = z.object({ email: z.email(), name: z.string().optional() });
export const TestRunnerTokenOutput = z.object({ token: z.string(), runnerId: z.string() });

// ───────────── 小さな道具 ─────────────

/** ProjectWithTeam のリーダー（無ければ null） */
export function leaderOf(project: ProjectWithTeam) {
  return project.agents.find((a) => a.role === "leader" && a.active) ?? null;
}
