// ランナー → Worker の REST（設計書 4.3）。テストでは BatonApi を FakeBatonApi に差し替える。
import {
  API_PATHS,
  AiChatOutput,
  ApiErrorSchema,
  AppendEventsOutput,
  ArtifactSchema,
  ClaimOutput,
  CreateAgentsOutput,
  CreateTasksOutput,
  DecisionSchema,
  HeartbeatOutput,
  InstructionSummarySchema,
  ProjectWithTeamSchema,
  RunnerInstructionState,
  TaskSchema,
  type Agent,
  type AiChatInput,
  type AppendEventsInput,
  type Artifact,
  type ClaimInput,
  type CreateAgentsInput,
  type CreateArtifactInput,
  type CreateDecisionInput,
  type CreateProjectInput,
  type CreateTasksInput,
  type Decision,
  type ErrorCode,
  type HeartbeatInput,
  type InstructionSummary,
  type ProjectWithTeam,
  type ReleaseInput,
  type RunnerInstructionPatch,
  type Task,
  type TaskPatch,
} from "@baton/shared";
import type { z } from "zod";
import { AiQuotaError, ApiError, ConflictError, NetworkError, isAbortError } from "./errors.ts";
import { sleep } from "./sync.ts";

type Opts = { signal?: AbortSignal };

export interface BatonApi {
  heartbeat(input: HeartbeatInput, opts?: Opts): Promise<z.infer<typeof HeartbeatOutput>>;
  /** 渡す指示が無ければ null（204） */
  claim(input: ClaimInput, opts?: Opts): Promise<z.infer<typeof ClaimOutput> | null>;
  getState(instructionId: string, opts?: Opts): Promise<z.infer<typeof RunnerInstructionState>>;
  patchInstruction(instructionId: string, patch: RunnerInstructionPatch, opts?: Opts): Promise<InstructionSummary>;
  release(instructionId: string, input: ReleaseInput, opts?: Opts): Promise<void>;
  createProject(input: CreateProjectInput, opts?: Opts): Promise<ProjectWithTeam>;
  addAgents(projectId: string, input: CreateAgentsInput, opts?: Opts): Promise<Agent[]>;
  createTasks(input: CreateTasksInput, opts?: Opts): Promise<Task[]>;
  patchTask(taskId: string, patch: TaskPatch, opts?: Opts): Promise<Task>;
  appendEvents(input: AppendEventsInput, opts?: Opts): Promise<{ lastSeq: number }>;
  createArtifact(input: CreateArtifactInput, opts?: Opts): Promise<Artifact>;
  createDecision(input: CreateDecisionInput, opts?: Opts): Promise<Decision>;
  /** 再試行しない（AI の再試行・退避先は orchestrator が 5.6 の規則で行う） */
  aiChat(input: AiChatInput, opts?: Opts): Promise<z.infer<typeof AiChatOutput>>;
}

/** レスポンスからエラーを作る。409 と ai_quota は専用のクラスにする */
export function toApiError(status: number, body: unknown): ApiError {
  const parsed = ApiErrorSchema.safeParse(body);
  const code: ErrorCode | "unknown" = parsed.success ? parsed.data.error.code : "unknown";
  const message = parsed.success ? parsed.data.error.message : `HTTP ${status}`;
  const details = parsed.success ? parsed.data.error.details : undefined;
  if (status === 409) return new ConflictError(message, details);
  if (code === "ai_quota") return new AiQuotaError(message, details);
  return new ApiError(status, code, message, details);
}

/** 再試行してよい失敗か（ネットワーク・5xx・rate_limited）。409 や 4xx は即座に諦める */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ConflictError || err instanceof AiQuotaError) return false;
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError) return err.status >= 500 || err.code === "rate_limited";
  if (isAbortError(err)) return false;
  return true; // fetch の TypeError（ネットワーク）など
}

export type HttpBatonApiOptions = {
  baseUrl: string;
  token: string;
  /** 失敗時の待ち時間（5.6: 1 秒・4 秒・15 秒） */
  retryDelaysMs?: number[];
  /** AI 呼び出し 1 回のタイムアウト */
  aiTimeoutMs?: number;
  /** AI 以外の API 1 回のタイムアウト（応答が来ない接続で claim やハートビートが止まらないように） */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class HttpBatonApi implements BatonApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly retryDelaysMs: number[];
  private readonly aiTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpBatonApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1000, 4000, 15000];
    this.aiTimeoutMs = opts.aiTimeoutMs ?? 120_000;
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
      // 1 回分の時間切れ（応答が来ない接続）も届かなかった扱いにして再試行する
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

  private async request(method: string, path: string, body: unknown, opts: Opts & { retry?: boolean; timeoutMs?: number | null } = {}): Promise<{ status: number; json: unknown }> {
    const timeoutMs = opts.timeoutMs === null ? undefined : (opts.timeoutMs ?? this.requestTimeoutMs);
    const delays = opts.retry === false ? [] : this.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, body, opts.signal, timeoutMs);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const delay = delays[attempt];
        if (delay === undefined || !isRetryable(err)) throw err;
        await sleep(delay, opts.signal);
      }
    }
  }

  async heartbeat(input: HeartbeatInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerHeartbeat, input, opts);
    return HeartbeatOutput.parse(r.json);
  }
  async claim(input: ClaimInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerClaim, input, opts);
    if (r.status === 204 || r.json === null) return null;
    return ClaimOutput.parse(r.json);
  }
  async getState(id: string, opts?: Opts) {
    const r = await this.request("GET", API_PATHS.runnerInstructionState(id), undefined, opts);
    return RunnerInstructionState.parse(r.json);
  }
  async patchInstruction(id: string, patch: RunnerInstructionPatch, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerInstruction(id), patch, opts);
    return InstructionSummarySchema.parse(r.json);
  }
  async release(id: string, input: ReleaseInput, opts?: Opts) {
    await this.request("POST", API_PATHS.runnerRelease(id), input, opts);
  }
  async createProject(input: CreateProjectInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerProjects, input, opts);
    return ProjectWithTeamSchema.parse(r.json);
  }
  async addAgents(projectId: string, input: CreateAgentsInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerProjectAgents(projectId), input, opts);
    return CreateAgentsOutput.parse(r.json).items;
  }
  async createTasks(input: CreateTasksInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerTasks, input, opts);
    return CreateTasksOutput.parse(r.json).items;
  }
  async patchTask(id: string, patch: TaskPatch, opts?: Opts) {
    const r = await this.request("PATCH", API_PATHS.runnerTask(id), patch, opts);
    return TaskSchema.parse(r.json);
  }
  async appendEvents(input: AppendEventsInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerEvents, input, opts);
    return AppendEventsOutput.parse(r.json);
  }
  async createArtifact(input: CreateArtifactInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerArtifacts, input, opts);
    return ArtifactSchema.parse(r.json);
  }
  async createDecision(input: CreateDecisionInput, opts?: Opts) {
    const r = await this.request("POST", API_PATHS.runnerDecisions, input, opts);
    return DecisionSchema.parse(r.json);
  }
  async aiChat(input: AiChatInput, opts?: Opts) {
    const timeout = AbortSignal.timeout(this.aiTimeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const r = await this.request("POST", API_PATHS.runnerAiChat, input, { signal, retry: false, timeoutMs: null });
    return AiChatOutput.parse(r.json);
  }
}
