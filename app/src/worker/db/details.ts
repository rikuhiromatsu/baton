// 指示の詳細とランナー用の状態（設計書 4.2・4.3・5.9）
import type { ArtifactMeta, Decision, InstructionDetail, Task } from "@baton/shared";
import { getProject } from "./projects.ts";
import { toArtifactMeta, toDecision, toTask, type ArtifactRow, type DecisionRow, type InstructionSummaryRow, type TaskRow } from "./rows.ts";
import { toClaimed } from "./instructions.ts";

const TASK_ORDER = "ORDER BY round, CASE kind WHEN 'plan' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, seq, created_at";

export const ARTIFACT_SELECT = `SELECT a.*, p.slug AS project_slug FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id`;

export async function loadInstructionParts(db: D1Database, id: string) {
  const [tasks, decisions, artifacts, lastSeq] = await db.batch([
    db.prepare(`SELECT * FROM tasks WHERE instruction_id = ? ${TASK_ORDER}`).bind(id),
    db.prepare("SELECT * FROM decisions WHERE instruction_id = ? ORDER BY created_at").bind(id),
    db.prepare(`${ARTIFACT_SELECT} WHERE a.instruction_id = ? ORDER BY a.created_at`).bind(id),
    db.prepare("SELECT max(seq) AS seq FROM agent_events WHERE instruction_id = ?").bind(id),
  ]);
  return {
    tasks: ((tasks?.results ?? []) as TaskRow[]).map(toTask) as Task[],
    decisions: ((decisions?.results ?? []) as DecisionRow[]).map(toDecision) as Decision[],
    artifacts: ((artifacts?.results ?? []) as ArtifactRow[]).map(toArtifactMeta) as ArtifactMeta[],
    lastEventSeq: ((lastSeq?.results?.[0] as { seq: number | null } | undefined)?.seq ?? -1) as number,
  };
}

export async function buildDetail(db: D1Database, row: InstructionSummaryRow): Promise<InstructionDetail> {
  const parts = await loadInstructionParts(db, row.id);
  const project = row.project_id ? await getProject(db, row.project_id) : null;
  return {
    instruction: { ...toClaimed(row), tokensIn: row.tokens_in, tokensOut: row.tokens_out },
    project,
    tasks: parts.tasks,
    decisions: parts.decisions,
    artifacts: parts.artifacts,
    lastEventSeq: parts.lastEventSeq,
  };
}
