// ランナー → Worker の REST（DESIGN-v2 12.3）。テストでは BatonApi を FakeBatonApi に差し替える。
// 再試行（1・4・15 秒）と 1 回ごとの時間切れは v1 のまま。409 は ConflictError（stale_revision は StaleRevisionError）。
import {
  API_PATHS,
  AgentSessionSummarySchema,
  AppendTranscriptOutput,
  ApiErrorSchema,
  ArtifactSchema,
  ClaimOutput,
  CreateTasksOutput,
  DecisionSchema,
  HeartbeatOutput,
  InstructionSummarySchema,
  ListWorkspacesOutput,
  PendingInputsOutput,
  ProjectProposalSchema,
  RunnerCreateProjectOutput,
  RunnerPostMessageOutput,
  TaskSchema,
  ThreadMessageSchema,
  WorkspaceSchema,
  type AgentSessionSummary,
  type AppendTranscriptInput,
  type Artifact,
  type ClaimInput,
  type CreateApprovalInput,
  type CreateArtifactInput,
  type CreateDecisionInput,
  type CreateSessionInput,
  type CreateTasksInput,
  type CreateWorkspaceInput,
  type Decision,
  type ErrorCode,
  type FinalizedInput,
  type HeartbeatInput,
  type InstructionReleaseInput,
  type InstructionSummary,
  type ProjectProposal,
  type PutReposInput,
  type RunnerCreateInstructionInput,
  type RunnerCreateProjectInput,
  type RunnerCreateProposalInput,
  type RunnerInboxInput,
  type RunnerInstructionPatch,
  type RunnerPatchMessageInput,
  type RunnerPostMessageInput,
  type SessionInput,
  type SessionPatch,
  type StreamInput,
  type Task,
  type TaskPatch,
  type ThreadMessage,
  type ThreadReleaseInput,
  type TurnDoneInput,
  type Workspace,
  type WorkspacePatch,
} from "@baton/shared";
import type { z } from "zod";
import { ApiError, ConflictError, NetworkError, StaleRevisionError, isAbortError } from "./errors.ts";
import { sleep } from "./sync.ts";

type Opts = { signal?: AbortSignal };

export type RunnerCreateProjectResult = z.infer<typeof RunnerCreateProjectOutput>;

export interface BatonApi {
  heartbeat(input: HeartbeatInput, opts?: Opts): Promise<z.infer<typeof HeartbeatOutput>>;
  /** 渡す仕事が無ければ null（204） */
  claim(input: ClaimInput, opts?: Opts): Promise<ClaimOutput | null>;

  // 会話
  postMessage(threadId: string, input: RunnerPostMessageInput, opts?: Opts): Promise<ThreadMessage>;
  patchMessage(threadId: string, messageId: string, input: RunnerPatchMessageInput, opts?: Opts): Promise<ThreadMessage | null>;
  /** ストリームの差分（D1 に書かない。失敗しても再試行しない） */
  stream(threadId: string, input: StreamInput, opts?: Opts): Promise<void>;
  pushInbox(threadId: string, input: RunnerInboxInput, opts?: Opts): Promise<void>;
  turnDone(threadId: string, input: TurnDoneInput, opts?: Opts): Promise<void>;
  releaseThread(threadId: string, input: ThreadReleaseInput, opts?: Opts): Promise<void>;

  // プロジェクト・指示・タスク
  createProposal(input: RunnerCreateProposalInput, opts?: Opts): Promise<ProjectProposal>;
  createProject(input: RunnerCreateProjectInput, opts?: Opts): Promise<RunnerCreateProjectResult>;
  createInstruction(input: RunnerCreateInstructionInput, opts?: Opts): Promise<InstructionSummary>;
  patchInstruction(id: string, patch: RunnerInstructionPatch, opts?: Opts): Promise<InstructionSummary>;
  releaseInstruction(id: string, input: InstructionReleaseInput, opts?: Opts): Promise<void>;
  finalized(id: string, input: FinalizedInput, opts?: Opts): Promise<void>;
  createTasks(input: CreateTasksInput, opts?: Opts): Promise<Task[]>;
  patchTask(id: string, patch: TaskPatch, opts?: Opts): Promise<Task>;

  // セッション・トランスクリプト・追加の依頼
  createSession(input: CreateSessionInput, opts?: Opts): Promise<AgentSessionSummary>;
  patchSession(id: string, patch: SessionPatch, opts?: Opts): Promise<AgentSessionSummary>;
  appendTranscript(input: AppendTranscriptInput, opts?: Opts): Promise<void>;
  pendingInputs(sessionId: string, opts?: Opts): Promise<SessionInput[]>;
  inputDelivered(inputId: string, opts?: Opts): Promise<void>;

  // 承認・判断・成果物
  createApproval(input: CreateApprovalInput, opts?: Opts): Promise<Decision>;
  createDecision(input: CreateDecisionInput, opts?: Opts): Promise<Decision>;
  getDecision(id: string, opts?: Opts): Promise<Decision>;
  createArtifact(input: CreateArtifactInput, opts?: Opts): Promise<Artifact>;

  // 作業場所・リポジトリ
  listWorkspaces(query: { status?: string; instructionId?: string }, opts?: Opts): Promise<Workspace[]>;
  createWorkspace(input: CreateWorkspaceInput, opts?: Opts): Promise<Workspace>;
  patchWorkspace(id: string, patch: WorkspacePatch, opts?: Opts): Promise<Workspace>;
  putRepos(input: PutReposInput, opts?: Opts): Promise<void>;
}

/** レスポンスからエラーを作る。409 は専用のクラスにする */
export function toApiError(status: number, body: unknown): ApiError {
  const parsed = ApiErrorSchema.safeParse(body);
  const code: ErrorCode | "unknown" = parsed.success ? parsed.data.error.code : "unknown";
  const message = parsed.success ? parsed.data.error.message : `HTTP ${status}`;
  const details = parsed.success ? parsed.data.error.details : undefined;
  if (status === 409 && code === "stale_revision") return new StaleRevisionError(message, details);
  if (status === 409) return new ConflictError(message, details);
  return new ApiError(status, code, message, details);
}

/** 再試行してよい失敗か（ネットワーク・5xx・rate_limited）。409 や 4xx は即座に諦める */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ConflictError || err instanceof StaleRevisionError) return false;
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) return err.status >= 500 || err.code === "rate_limited";
  if (isAbortError(err)) return false;
  return true; // fetch の TypeError（ネットワーク）など
}

export type HttpBatonApiOptions = {
  baseUrl: string;
  token: string;
  /** 失敗時の待ち時間（1 秒・4 秒・15 秒） */
  retryDelaysMs?: number[];
  /** 1 回のタイムアウト（応答が来ない接続で claim やハートビートが止まらないように） */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class HttpBatonApi implements BatonApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly retryDelaysMs: number[];
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpBatonApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1000, 4000, 15000];
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async once(method: string, path: string, body: unknown, parent?: AbortSignal, timeoutMs?: number): Promise<{ status: number; json: unknown }> {
    const signal = timeoutMs ? (parent ? AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)) : parent;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      text = await res.text();
    } catch (err) {
      if (parent?.aborted) throw parent.reason ?? err;
      if (isAbortError(err) && !timeoutMs) throw err;
      throw new NetworkError(`Worker に届きません: ${(err as Error)?.message ?? String(err)}`);
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) throw toApiError(res.status, json);
    return { status: res.status, json };
  }

  private async request(method: string, path: string, body: unknown, opts: Opts & { retry?: boolean } = {}): Promise<{ status: number; json: unknown }> {
    const delays = opts.retry === false ? [] : this.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, body, opts.signal, this.requestTimeoutMs);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const delay = delays[attempt];
        if (delay === undefined || !isRetryable(err)) throw err;
        await sleep(delay, opts.signal);
      }
    }
  }

  async heartbeat(input: HeartbeatInput, opts?: Opts) {
    return HeartbeatOutput.parse((await this.request("POST", API_PATHS.runnerHeartbeat, input, opts)).json);
  }
  async claim(input: ClaimInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerClaim, input, opts);
    if (r.status === 204 || r.json === null) return null;
    return ClaimOutput.parse(r.json);
  }
  async postMessage(threadId: string, input: RunnerPostMessageInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerThreadMessages(threadId), input, opts);
    return RunnerPostMessageOutput.parse(r.json).message;
  }
  async patchMessage(threadId: string, messageId: string, input: RunnerPatchMessageInput, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerThreadMessage(threadId, messageId), input, opts);
    if (r.status === 204 || r.json === null) return null;
    const m = (r.json as { message?: unknown }).message ?? r.json;
    const parsed = ThreadMessageSchema.safeParse(m);
    return parsed.success ? parsed.data : null;
  }
  async stream(threadId: string, input: StreamInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerThreadStream(threadId), input, { ...opts, retry: false });
  }
  async pushInbox(threadId: string, input: RunnerInboxInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerThreadInbox(threadId), input, opts);
  }
  async turnDone(threadId: string, input: TurnDoneInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerThreadTurnDone(threadId), input, opts);
  }
  async releaseThread(threadId: string, input: ThreadReleaseInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerThreadRelease(threadId), input, opts);
  }
  async createProposal(input: RunnerCreateProposalInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerProjectProposals, input, opts);
    return ProjectProposalSchema.parse((r.json as { proposal?: unknown }).proposal ?? r.json);
  }
  async createProject(input: RunnerCreateProjectInput, opts?: Opts) {
    return RunnerCreateProjectOutput.parse((await this.request("POST", API_PATHS.runnerProjects, input, opts)).json);
  }
  async createInstruction(input: RunnerCreateInstructionInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerInstructions, input, opts);
    return InstructionSummarySchema.parse((r.json as { instruction?: unknown }).instruction ?? r.json);
  }
  async patchInstruction(id: string, patch: RunnerInstructionPatch, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerInstruction(id), patch, opts);
    return InstructionSummarySchema.parse((r.json as { instruction?: unknown }).instruction ?? r.json);
  }
  async releaseInstruction(id: string, input: InstructionReleaseInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerInstructionRelease(id), input, opts);
  }
  async finalized(id: string, input: FinalizedInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerInstructionFinalized(id), input, opts);
  }
  async createTasks(input: CreateTasksInput, opts?: Opts) {
    return CreateTasksOutput.parse((await this.request("POST", API_PATHS.runnerTasks, input, opts)).json).items;
  }
  async patchTask(id: string, patch: TaskPatch, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerTask(id), patch, opts);
    return TaskSchema.parse((r.json as { task?: unknown }).task ?? r.json);
  }
  async createSession(input: CreateSessionInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerSessions, input, opts);
    return AgentSessionSummarySchema.parse((r.json as { session?: unknown }).session ?? r.json);
  }
  async patchSession(id: string, patch: SessionPatch, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerSession(id), patch, opts);
    return AgentSessionSummarySchema.parse((r.json as { session?: unknown }).session ?? r.json);
  }
  async appendTranscript(input: AppendTranscriptInput, opts?: Opts) {
    AppendTranscriptOutput.safeParse((await this.request("POST", API_PATHS.runnerTranscript, input, opts)).json);
  }
  async pendingInputs(sessionId: string, opts?: Opts) {
    return PendingInputsOutput.parse((await this.request("GET", API_PATHS.runnerSessionInputs(sessionId), undefined, opts)).json).items;
  }
  async inputDelivered(inputId: string, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerInputDelivered(inputId), {}, opts);
  }
  async createApproval(input: CreateApprovalInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerApprovals, input, opts);
    return DecisionSchema.parse((r.json as { decision?: unknown }).decision ?? r.json);
  }
  async createDecision(input: CreateDecisionInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerDecisions, input, opts);
    return DecisionSchema.parse((r.json as { decision?: unknown }).decision ?? r.json);
  }
  async getDecision(id: string, opts?: Opts) {
    const r = await this.request("GET", API_PATHS.runnerDecision(id), undefined, opts);
    return DecisionSchema.parse((r.json as { decision?: unknown }).decision ?? r.json);
  }
  async createArtifact(input: CreateArtifactInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerArtifacts, input, opts);
    return ArtifactSchema.parse((r.json as { artifact?: unknown }).artifact ?? r.json);
  }
  async listWorkspaces(query: { status?: string; instructionId?: string }, opts?: Opts) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    const r = await this.request("GET", `${API_PATHS.runnerWorkspaces}${qs ? `?${qs}` : ""}`, undefined, opts);
    return ListWorkspacesOutput.parse(r.json).items;
  }
  async createWorkspace(input: CreateWorkspaceInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerWorkspaces, input, opts);
    return WorkspaceSchema.parse((r.json as { workspace?: unknown }).workspace ?? r.json);
  }
  async patchWorkspace(id: string, patch: WorkspacePatch, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerWorkspace(id), patch, opts);
    return WorkspaceSchema.parse((r.json as { workspace?: unknown }).workspace ?? r.json);
  }
  async putRepos(input: PutReposInput, opts?: Opts) {
    await this.request("PUT", API_PATHS.runnerRepos, input, opts);
  }
}
