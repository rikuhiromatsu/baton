// ランナー内で使うエラーの種類。orchestrator がこれを見て「失敗にする／release する／黙って止める」を決める。
import type { ErrorCode } from "@baton/shared";

/** Worker が返したエラー（4.1 の形） */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "unknown";
  readonly details: unknown;
  constructor(status: number, code: ErrorCode | "unknown", message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Worker に届かなかった（名前解決・接続・切断など）。再試行の対象 */
export class NetworkError extends ApiError {
  constructor(message: string) {
    super(0, "unknown", message);
    this.name = "NetworkError";
  }
}

/** 409。その指示をもう握っていない（取消・判断待ち・lease 切れ）。即座に処理を打ち切る */
export class ConflictError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
    this.name = "ConflictError";
  }
}

/** 429 ai_quota。日の枠切れなら retryAt まで待つ。scope=instruction なら指示の上限 */
export class AiQuotaError extends ApiError {
  readonly retryAt: number | null;
  readonly scope: string | null;
  constructor(message: string, details?: unknown) {
    super(429, "ai_quota", message, details);
    this.name = "AiQuotaError";
    const d = (details ?? {}) as { retryAt?: unknown; scope?: unknown };
    this.retryAt = typeof d.retryAt === "number" ? d.retryAt : null;
    this.scope = typeof d.scope === "string" ? d.scope : null;
  }
}

/** 上限（回数・トークン・時間など）に達した。指示を failed にし、error に「上限: 〇〇」 */
export class LimitError extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`上限: ${what}`);
    this.name = "LimitError";
    this.what = what;
  }
}

/** 段階が回復できない形で失敗した（AI が使えない、JSON が直らないなど） */
export class StageFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageFailedError";
  }
}

/** AbortController.abort() に渡す理由 */
export type StopReason = "cancel" | "shutdown" | "decision";
export class StopSignal extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason) {
    super(`stopped: ${reason}`);
    this.name = "StopSignal";
    this.reason = reason;
  }
}

export function stopReasonOf(signal: AbortSignal): StopReason | null {
  if (!signal.aborted) return null;
  const r: unknown = signal.reason;
  return r instanceof StopSignal ? r.reason : "cancel";
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof StopSignal ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** CEO への判断を作った。この指示の処理はここで終える（5.7） */
export class DecisionRequested extends Error {
  readonly decisionId: string;
  constructor(decisionId: string) {
    super("CEO の判断待ち");
    this.name = "DecisionRequested";
    this.decisionId = decisionId;
  }
}

/** work タスクがすべて失敗した（8.2.1: リーダーのまとめに進まず指示を failed） */
export class AllWorkFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllWorkFailedError";
  }
}
