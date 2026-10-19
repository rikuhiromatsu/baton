// API のエラー（設計書 4.1）。投げればエラーハンドラが { error: { code, message, details } } に変える
import { ERROR_STATUS, type ErrorCode } from "@baton/shared";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export const notFound = (what = "not found") => new ApiError("not_found", what);
export const conflict = (message: string, details?: unknown) => new ApiError("conflict", message, details);
export const invalid = (message: string, details?: unknown) => new ApiError("invalid", message, details);
