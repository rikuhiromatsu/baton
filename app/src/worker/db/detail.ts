// 指示の詳細（DESIGN-v2 12.6・13.7）
import { COO_THREAD_ID, type InstructionDetail, type WorkspaceDiff } from "@baton/shared";
import { getSummary } from "./instructions.ts";
import { getProject, leaderThreadIdOf } from "./projects.ts";
import {
  toAgentSession,
  toArtifactMeta,
  toDecision,
  toTask,
  toWorkspace,
  type AgentSessionRow,
  type ArtifactRow,
  type DecisionRow,
  type InstructionRow,
  type TaskRow,
  type WorkspaceRow,
} from "./rows.ts";
import { getMessage } from "./threads.ts";
import { clip, parseObject } from "../lib/json.ts";

const TASK_ORDER = "ORDER BY round, CASE kind WHEN 'plan' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, seq, created_at";
export const ARTIFACT_SELECT = `SELECT a.*, p.slug AS project_slug FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id`;

export async function buildDetail(db: D1Database, row: InstructionRow): Promise<InstructionDetail> {
  const id = row.id;
  const [tasks, decisions, artifacts, sessions, workspaces] = await db.batch([
    db.prepare(`SELECT * FROM tasks WHERE instruction_id = ? ${TASK_ORDER}`).bind(id),
    db.prepare("SELECT * FROM decisions WHERE instruction_id = ? ORDER BY created_at").bind(id),
    db.prepare(`${ARTIFACT_SELECT} WHERE a.instruction_id = ? ORDER BY a.created_at`).bind(id),
    // メンバーのセッションと、この指示を扱ったスレッドのセッション（COO・リーダーのタブ）
    db
      .prepare(
        `SELECT * FROM agent_sessions WHERE instruction_id = ?1
            OR id IN (SELECT DISTINCT session_id FROM transcript_items WHERE instruction_id = ?1)
          ORDER BY CASE role WHEN 'coo' THEN 0 WHEN 'leader' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, created_at`,
      )
      .bind(id),
    db.prepare("SELECT * FROM workspaces WHERE instruction_id = ? ORDER BY CASE purpose WHEN 'integration' THEN 0 ELSE 1 END, created_at").bind(id),
  ]);
  const summary = (await getSummary(db, id))!;
  const decisionList = ((decisions?.results ?? []) as DecisionRow[]).map(toDecision);
  const project = row.project_id ? await getProject(db, row.project_id) : null;
  return {
    instruction: { ...summary, feedback: row.feedback, attempt: row.attempt, originThreadId: row.origin_thread_id, finalizedAt: row.finalized_at },
    project,
    tasks: ((tasks?.results ?? []) as TaskRow[]).map(toTask),
    decisions: decisionList,
    openDecisions: decisionList.filter((d) => d.status === "open"),
    artifacts: ((artifacts?.results ?? []) as ArtifactRow[]).map(toArtifactMeta),
    sessions: ((sessions?.results ?? []) as AgentSessionRow[]).map(toAgentSession),
    workspaces: ((workspaces?.results ?? []) as WorkspaceRow[]).map(toWorkspace),
    originMessage: row.origin_message_id ? await getMessage(db, row.origin_message_id) : null,
    cooThreadId: COO_THREAD_ID,
    leaderThreadId: row.project_id ? leaderThreadIdOf(row.project_id) : null,
  };
}

/** 統合用の差分（13.7 の「変更」）。Codex の指摘があれば要約を添える */
export async function buildDiff(db: D1Database, instructionId: string): Promise<WorkspaceDiff> {
  const ws = await db
    .prepare("SELECT * FROM workspaces WHERE instruction_id = ? AND purpose = 'integration' ORDER BY created_at DESC LIMIT 1")
    .bind(instructionId)
    .first<WorkspaceRow>();
  const review = await db
    .prepare("SELECT payload FROM thread_inbox WHERE instruction_id = ? AND kind = 'review_findings' ORDER BY created_at DESC LIMIT 1")
    .bind(instructionId)
    .first<{ payload: string }>();
  const reviewText = review ? parseObject(review.payload).text : null;
  const workspace = ws ? toWorkspace(ws) : null;
  return {
    workspace,
    files: workspace?.diffStat ?? [],
    patch: ws?.diff_patch ?? null,
    truncated: ws?.diff_truncated === 1,
    reviewSummary: typeof reviewText === "string" && reviewText ? clip(reviewText, 2000) : null,
  };
}
