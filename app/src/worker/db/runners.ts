// ランナーの状態（設計書 1.5・D-30）
import { LIMITS, type RunnerStatus } from "@baton/shared";
import type { RunnerRow } from "./rows.ts";

export function parseRunnerStatusJson(text: string): { activeInstructionIds: string[]; maxConcurrent?: number } {
  try {
    const v = JSON.parse(text) as { activeInstructionIds?: unknown; maxConcurrent?: unknown };
    const ids = Array.isArray(v.activeInstructionIds) ? v.activeInstructionIds.filter((x): x is string => typeof x === "string") : [];
    return { activeInstructionIds: ids, maxConcurrent: typeof v.maxConcurrent === "number" ? v.maxConcurrent : undefined };
  } catch {
    return { activeInstructionIds: [] };
  }
}

/** 最後にハートビートを送ってきた（失効していない）ランナー */
export async function latestRunner(db: D1Database): Promise<RunnerRow | null> {
  return db
    .prepare("SELECT * FROM runners WHERE revoked = 0 ORDER BY last_heartbeat_at IS NULL, last_heartbeat_at DESC, created_at DESC LIMIT 1")
    .first<RunnerRow>();
}

export function runnerStatusFromRow(row: RunnerRow | null, now: number, override?: { online: boolean }): RunnerStatus {
  if (!row) {
    return { online: override?.online ?? false, lastHeartbeatAt: null, activeInstructionIds: [], version: null, tailnetUrl: null };
  }
  const recent = row.last_heartbeat_at !== null && now - row.last_heartbeat_at <= LIMITS.runnerOnlineWindowMs;
  return {
    online: override ? override.online : recent,
    lastHeartbeatAt: row.last_heartbeat_at,
    activeInstructionIds: parseRunnerStatusJson(row.status).activeInstructionIds,
    version: row.version,
    tailnetUrl: row.tailnet_url,
  };
}

export async function getRunnerStatus(db: D1Database, now: number): Promise<RunnerStatus> {
  return runnerStatusFromRow(await latestRunner(db), now);
}
