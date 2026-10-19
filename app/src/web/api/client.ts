// 共有パッケージのパス定数と型から作った薄い fetch クライアント（D-14。hono/client は使わない）
import {
  API_PATHS,
  CSRF_HEADER,
  type AnswerDecisionInput,
  type AnswerDecisionOutput,
  type Artifact,
  type CreateInstructionInput,
  type ErrorCode,
  type InstructionDetail,
  type InstructionSummary,
  type ListEventsOutput,
  type ListInstructionsOutput,
  type ListProjectsOutput,
  type SessionInfo,
  type TransitionInput,
  type TransitionOutput,
  type UndoOutput,
  type UsageToday,
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";

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
  const text = await res.text();
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
  return json as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  session: (signal?: AbortSignal) => request<SessionInfo>("GET", API_PATHS.session, undefined, signal),
  logout: () => request<void>("POST", API_PATHS.authLogout),
  loginUrl: (redirect: string) => `${API_PATHS.authLogin}${qs({ redirect })}`,
  listInstructions: (view: "active" | "archived", cursor?: string | null, signal?: AbortSignal) =>
    request<ListInstructionsOutput>("GET", `${API_PATHS.instructions}${qs({ view, cursor })}`, undefined, signal),
  createInstruction: (input: CreateInstructionInput) => request<InstructionSummary>("POST", API_PATHS.instructions, input),
  getInstruction: (id: string, signal?: AbortSignal) => request<InstructionDetail>("GET", API_PATHS.instruction(id), undefined, signal),
  listEvents: (id: string, after: number, signal?: AbortSignal) =>
    request<ListEventsOutput>("GET", `${API_PATHS.instructionEvents(id)}${qs({ after, limit: 200 })}`, undefined, signal),
  transition: (id: string, input: TransitionInput) => request<TransitionOutput>("POST", API_PATHS.instructionTransition(id), input),
  undo: (transitionId: string) => request<UndoOutput>("POST", API_PATHS.transitionUndo(transitionId)),
  answerDecision: (id: string, input: AnswerDecisionInput) => request<AnswerDecisionOutput>("POST", API_PATHS.decisionAnswer(id), input),
  projects: (signal?: AbortSignal) => request<ListProjectsOutput>("GET", API_PATHS.projects, undefined, signal),
  artifact: (id: string, signal?: AbortSignal) => request<Artifact>("GET", API_PATHS.artifact(id), undefined, signal),
  usageToday: (signal?: AbortSignal) => request<UsageToday>("GET", API_PATHS.usageToday, undefined, signal),
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
