// 共有パッケージのパス定数と型から作った薄い fetch クライアント（D-14。hono/client は使わない）
import {
  API_PATHS,
  CSRF_HEADER,
  type AcceptProposalInput,
  type AcceptProposalOutput,
  type AnswerDecisionInput,
  type AnswerDecisionOutput,
  type Artifact,
  type BotAuditItem,
  type BotTokenView,
  type CreateBotTokenInput,
  type CreateBotTokenOutput,
  type CreatePushSubscriptionInput,
  type ErrorCode,
  type GetProposalOutput,
  type InstructionDetail,
  type InstructionSummary,
  type ListInstructionsOutput,
  type ListMessagesOutput,
  type ListProfilesOutput,
  type ListProjectsOutput,
  type ListReposOutput,
  type ListThreadsOutput,
  type OrgSnapshot,
  type PatchProjectInput,
  type PostMessageInput,
  type PostMessageOutput,
  type PostSessionMessageInput,
  type ProjectProposal,
  type ProjectWithTeam,
  type PushSubscriptionView,
  type QuotaOutput,
  type SessionInfo,
  type SessionInput,
  type SidebarOutput,
  type ThreadMessage,
  type TranscriptItem,
  type TranscriptOutput,
  type TransitionInput,
  type TransitionOutput,
  type UndoOutput,
  type WorkspaceDiff,
} from "@baton/shared";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "network";
  readonly details: unknown;
  constructor(status: number, code: ErrorCode | "network", message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof ApiError && e.code === "network";
}
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}

type Config = {
  fetch: FetchLike;
  onUnauthorized: () => void;
};

const config: Config = {
  fetch: (input, init) => fetch(input, init),
  onUnauthorized: () => {},
};

let csrfToken: string | null = null;
let sessionLoader: (() => Promise<unknown>) | null = null;

/** モックに差し替えるときに使う */
export function setTransport(f: FetchLike): void {
  config.fetch = f;
}
export function setUnauthorizedHandler(h: () => void): void {
  config.onUnauthorized = h;
}
/** CSRF トークンはメモリにだけ持つ（6.3） */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}
export function getCsrfToken(): string | null {
  return csrfToken;
}
/** CSRF トークンが無いときに GET /api/session を呼ぶ関数（main が登録） */
export function setSessionLoader(loader: (() => Promise<unknown>) | null): void {
  sessionLoader = loader;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    if (!csrfToken && sessionLoader) await sessionLoader().catch(() => {});
    if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  }
  let res: Response;
  try {
    res = await config.fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, "network", e instanceof Error ? e.message : "network");
  }
  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: ErrorCode; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401) config.onUnauthorized();
    throw new ApiError(res.status, err?.code ?? "internal", err?.message ?? res.statusText, err?.details);
  }
  return (json ?? undefined) as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  // 認証
  session: (signal?: AbortSignal) => request<SessionInfo>("GET", API_PATHS.session, undefined, signal),
  logout: () => request<void>("POST", API_PATHS.authLogout),
  loginUrl: (redirect: string) => `${API_PATHS.authLogin}${qs({ redirect })}`,

  // 会話（12.2）
  threads: (signal?: AbortSignal) => request<ListThreadsOutput>("GET", API_PATHS.threads, undefined, signal),
  messages: (threadId: string, before?: number | null, signal?: AbortSignal) =>
    request<ListMessagesOutput>("GET", `${API_PATHS.threadMessages(threadId)}${qs({ before })}`, undefined, signal),
  postMessage: (threadId: string, input: PostMessageInput) => request<PostMessageOutput>("POST", API_PATHS.threadMessages(threadId), input),
  readThread: (threadId: string, seq: number) => request<void>("POST", API_PATHS.threadRead(threadId), { seq }),
  leaveThread: (threadId: string) => request<void>("POST", API_PATHS.threadLeave(threadId)),
  interruptThread: (threadId: string) => request<void>("POST", API_PATHS.threadInterrupt(threadId)),
  resetThread: (threadId: string) => request<{ message: ThreadMessage }>("POST", API_PATHS.threadReset(threadId)),
  proposal: (id: string, signal?: AbortSignal) => request<GetProposalOutput>("GET", API_PATHS.proposal(id), undefined, signal),
  acceptProposal: (id: string, input: AcceptProposalInput) => request<AcceptProposalOutput>("POST", API_PATHS.proposalAccept(id), input),
  declineProposal: (id: string) => request<void>("POST", API_PATHS.proposalDecline(id)),

  // 指示
  listInstructions: (view: "active" | "archived", cursor?: string | null, signal?: AbortSignal) =>
    request<ListInstructionsOutput>("GET", `${API_PATHS.instructions}${qs({ view, cursor })}`, undefined, signal),
  getInstruction: (id: string, signal?: AbortSignal) => request<InstructionDetail>("GET", API_PATHS.instruction(id), undefined, signal),
  transition: (id: string, input: TransitionInput) => request<TransitionOutput>("POST", API_PATHS.instructionTransition(id), input),
  undo: (transitionId: string) => request<UndoOutput>("POST", API_PATHS.transitionUndo(transitionId)),
  answerDecision: (id: string, input: AnswerDecisionInput) => request<AnswerDecisionOutput>("POST", API_PATHS.decisionAnswer(id), input),
  diff: (id: string, signal?: AbortSignal) => request<WorkspaceDiff>("GET", API_PATHS.instructionDiff(id), undefined, signal),
  artifact: (id: string, signal?: AbortSignal) => request<Artifact>("GET", API_PATHS.artifact(id), undefined, signal),

  // セッションとトランスクリプト
  transcript: (sessionId: string, opts: { instructionId?: string | null; before?: number | null; after?: number | null }, signal?: AbortSignal) =>
    request<TranscriptOutput>(
      "GET",
      `${API_PATHS.sessionTranscript(sessionId)}${qs({ instructionId: opts.instructionId, before: opts.before, after: opts.after })}`,
      undefined,
      signal,
    ),
  transcriptItem: (id: string, signal?: AbortSignal) => request<TranscriptItem>("GET", API_PATHS.transcriptItem(id), undefined, signal),
  postSessionMessage: (sessionId: string, input: PostSessionMessageInput) =>
    request<{ input: SessionInput }>("POST", API_PATHS.sessionMessages(sessionId), input),
  interruptSession: (sessionId: string) => request<void>("POST", API_PATHS.sessionInterrupt(sessionId)),

  // 組織・プロジェクト
  org: (signal?: AbortSignal) => request<OrgSnapshot>("GET", API_PATHS.org, undefined, signal),
  sidebar: (signal?: AbortSignal) => request<SidebarOutput>("GET", API_PATHS.projectsSidebar, undefined, signal),
  projects: (signal?: AbortSignal) => request<ListProjectsOutput>("GET", API_PATHS.projects, undefined, signal),
  patchProject: (id: string, input: PatchProjectInput) => request<{ project: ProjectWithTeam }>("PATCH", API_PATHS.project(id), input),
  createProjectFromRepo: (repoPath: string) => request<{ proposal: ProjectProposal }>("POST", API_PATHS.projects, { repoPath }),
  repos: (signal?: AbortSignal) => request<ListReposOutput>("GET", API_PATHS.repos, undefined, signal),
  profiles: (signal?: AbortSignal) => request<ListProfilesOutput>("GET", API_PATHS.profiles, undefined, signal),
  quota: (signal?: AbortSignal) => request<QuotaOutput>("GET", API_PATHS.quota, undefined, signal),

  // 通知（10 章）
  pushSubscriptions: (signal?: AbortSignal) => request<{ items: PushSubscriptionView[] }>("GET", API_PATHS.pushSubscriptions, undefined, signal),
  createPushSubscription: (input: CreatePushSubscriptionInput) => request<unknown>("POST", API_PATHS.pushSubscriptions, input),
  deletePushSubscription: (id: string) => request<void>("DELETE", API_PATHS.pushSubscription(id)),

  // 秘書のトークン（11.3）
  botTokens: (signal?: AbortSignal) => request<{ items: BotTokenView[] }>("GET", API_PATHS.botTokens, undefined, signal),
  createBotToken: (input: CreateBotTokenInput) => request<CreateBotTokenOutput>("POST", API_PATHS.botTokens, input),
  revokeBotToken: (id: string) => request<void>("DELETE", API_PATHS.botToken(id)),
  botAudit: (id: string, cursor?: string | null, signal?: AbortSignal) =>
    request<{ items: BotAuditItem[]; nextCursor: string | null }>("GET", `${API_PATHS.botTokenAudit(id)}${qs({ cursor })}`, undefined, signal),
};

/** 一覧はページをたどって全部集める（個人用で件数は少ない。上限 10 ページ） */
export async function listAllInstructions(view: "active" | "archived", signal?: AbortSignal): Promise<ListInstructionsOutput> {
  const items: InstructionSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res: ListInstructionsOutput = await api.listInstructions(view, cursor, signal);
    items.push(...res.items);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return { items, nextCursor: null };
}
