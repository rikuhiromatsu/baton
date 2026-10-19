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

/** 409。その指示・スレッドをもう握っていない（取消・lease 切れ）。即座に処理を打ち切る */
export class ConflictError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
    this.name = "ConflictError";
  }
}

/** 409 stale_revision。COO の present・relay の版が古い（4.6・D-79） */
export class StaleRevisionError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(409, "stale_revision", message, details);
    this.name = "StaleRevisionError";
  }
}

/** 上限（推定額・時間・承認の回数など）に達した。指示を failed にし、error に「上限に達しました: 〇〇」 */
export class LimitError extends Error {
  readonly what: string;
  constructor(what: string) {
    super(`上限に達しました: ${what}`);
    this.name = "LimitError";
    this.what = what;
  }
}

/** サブスク以外の認証・MCP の漏れ（7.7・D-48）。以後の起動を止める */
export class AuthGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthGuardError";
  }
}

/** サブスクの枠切れ（9.2） */
export class QuotaBlockedError extends Error {
  readonly blockedUntil: number;
  constructor(blockedUntil: number) {
    super("サブスクの枠切れ");
    this.name = "QuotaBlockedError";
    this.blockedUntil = blockedUntil;
  }
}

/** AbortController.abort() に渡す理由 */
export type StopReason = "cancel" | "shutdown" | "interrupt" | "approval_timeout" | "quota" | "auth";
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
  return err instanceof StopSignal || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
