// ランナーの状態・枠・プロファイル（v1 設計書 1.5・D-30、DESIGN-v2 6.2・9 章）
import { EMPTY_QUOTA, LIMITS, ProfileViewSchema, QuotaStatusSchema, type ProfileView, type QuotaStatus, type RunnerStatus } from "@baton/shared";
import { z } from "zod";
import { parseJson } from "../lib/json.ts";
import type { RunnerRow } from "./rows.ts";

/** runners.status（JSON）に入れているもの */
export type RunnerStatusJson = {
  activeInstructionIds: string[];
  activeSessionIds: string[];
  activeThreadIds: string[];
  profiles: ProfileView[];
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseRunnerStatusJson(text: string): RunnerStatusJson {
  const v = parseJson<Record<string, unknown>>(text, {});
  const profiles = z.array(ProfileViewSchema).safeParse(v.profiles);
  return {
    activeInstructionIds: strings(v.activeInstructionIds),
    activeSessionIds: strings(v.activeSessionIds),
    activeThreadIds: strings(v.activeThreadIds),
    profiles: profiles.success ? profiles.data : [],
  };
}

export function parseQuota(text: string | null | undefined): QuotaStatus {
  const r = QuotaStatusSchema.safeParse(parseJson<unknown>(text, null));
  return r.success ? r.data : EMPTY_QUOTA;
}

/** 最後にハートビートを送ってきた（失効していない）ランナー */
export async function latestRunner(db: D1Database): Promise<RunnerRow | null> {
  return db
    .prepare("SELECT * FROM runners WHERE revoked = 0 ORDER BY last_heartbeat_at IS NULL, last_heartbeat_at DESC, created_at DESC LIMIT 1")
    .first<RunnerRow>();
}

export function runnerStatusFromRow(row: RunnerRow | null, now: number, override?: { online: boolean }): RunnerStatus {
  if (!row) {
    return {
      online: override?.online ?? false,
      lastHeartbeatAt: null,
      activeInstructionIds: [],
      activeSessionIds: [],
      version: null,
      tailnetUrl: null,
      claudeVersion: null,
      claudeAuth: "unknown",
    };
  }
  const recent = row.last_heartbeat_at !== null && now - row.last_heartbeat_at <= LIMITS.runnerOnlineWindowMs;
  const s = parseRunnerStatusJson(row.status);
  return {
    online: override ? override.online : recent,
    lastHeartbeatAt: row.last_heartbeat_at,
    activeInstructionIds: s.activeInstructionIds,
    activeSessionIds: s.activeSessionIds,
    version: row.version,
    tailnetUrl: row.tailnet_url,
    claudeVersion: row.claude_version,
    claudeAuth: row.claude_auth ?? "unknown",
  };
}

export async function getRunnerStatus(db: D1Database, now: number): Promise<RunnerStatus> {
  return runnerStatusFromRow(await latestRunner(db), now);
}

export async function getQuota(db: D1Database): Promise<QuotaStatus> {
  return parseQuota((await latestRunner(db))?.quota);
}

export async function getProfiles(db: D1Database): Promise<ProfileView[]> {
  const row = await latestRunner(db);
  return row ? parseRunnerStatusJson(row.status).profiles : [];
}
