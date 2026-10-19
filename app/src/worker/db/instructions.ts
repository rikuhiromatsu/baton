// 指示のリポジトリ（設計書 3.2・4.2・7.3）
import {
  HOME_STATUS_ORDER,
  LIMITS,
  RECENT_DAYS_FOR_CLOSED,
  type ClaimedInstruction,
  type InstructionSummary,
} from "@baton/shared";
import { DAY_MS } from "../lib/time.ts";
import { toSummary, type InstructionRow, type InstructionSummaryRow } from "./rows.ts";

/** 一覧と同じ形の行を作る SELECT。taskCounts は work タスクだけを数える */
export const SUMMARY_SELECT = `
SELECT i.*,
  p.name AS project_name,
  (SELECT d.id FROM decisions d WHERE d.instruction_id = i.id AND d.status = 'open'
     ORDER BY d.created_at DESC LIMIT 1) AS open_decision_id,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work') AS tc_total,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work' AND t.status = 'done') AS tc_done,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work' AND t.status = 'running') AS tc_running,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work' AND t.status = 'failed') AS tc_failed
FROM instructions i
LEFT JOIN projects p ON p.id = i.project_id`;

/** 7.3 の並び順（status の順位） */
const STATUS_RANK_SQL = `CASE i.status ${HOME_STATUS_ORDER.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} ELSE 99 END`;

export async function getInstructionRow(db: D1Database, id: string): Promise<InstructionRow | null> {
  return db.prepare("SELECT * FROM instructions WHERE id = ?").bind(id).first<InstructionRow>();
}

export function summaryStatement(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare(`${SUMMARY_SELECT} WHERE i.id = ?`).bind(id);
}

export async function getSummaryRow(db: D1Database, id: string): Promise<InstructionSummaryRow | null> {
  return summaryStatement(db, id).first<InstructionSummaryRow>();
}

export async function getSummary(db: D1Database, id: string): Promise<InstructionSummary | null> {
  const row = await getSummaryRow(db, id);
  return row ? toSummary(row) : null;
}

export function toClaimed(row: InstructionSummaryRow): ClaimedInstruction {
  return { ...toSummary(row), feedback: row.feedback, attempt: row.attempt };
}

export async function getClaimed(db: D1Database, id: string): Promise<ClaimedInstruction | null> {
  const row = await getSummaryRow(db, id);
  return row ? toClaimed(row) : null;
}

/** カーソルは「何件目から」の数字（個人用で件数が少ないため、オフセットで十分） */
export async function listInstructions(
  db: D1Database,
  view: "active" | "archived",
  cursor: string | undefined,
  now: number,
): Promise<{ items: InstructionSummary[]; nextCursor: string | null }> {
  const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const limit = LIMITS.pageSize;
  let stmt: D1PreparedStatement;
  if (view === "archived") {
    stmt = db
      .prepare(`${SUMMARY_SELECT} WHERE i.status = 'archived' ORDER BY i.status_changed_at DESC, i.id LIMIT ? OFFSET ?`)
      .bind(limit + 1, offset);
  } else {
    const closedSince = now - RECENT_DAYS_FOR_CLOSED * DAY_MS;
    stmt = db
      .prepare(
        `${SUMMARY_SELECT}
         WHERE i.status <> 'archived'
           AND (i.status NOT IN ('done','canceled') OR i.status_changed_at >= ?)
         ORDER BY ${STATUS_RANK_SQL}, i.status_changed_at DESC, i.id
         LIMIT ? OFFSET ?`,
      )
      .bind(closedSince, limit + 1, offset);
  }
  const { results } = await stmt.all<InstructionSummaryRow>();
  const hasMore = results.length > limit;
  return {
    items: results.slice(0, limit).map(toSummary),
    nextCursor: hasMore ? String(offset + limit) : null,
  };
}

/** 遷移の記録。直前の UPDATE が 1 行を変えたときだけ入る（DB.batch の中で使う） */
export function transitionAfterUpdate(
  db: D1Database,
  t: { id: string; instructionId: string; from: string; to: string; action: string; actor: "ceo" | "runner" | "system"; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO status_transitions (id, instruction_id, from_status, to_status, action, actor, undone, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 0, ? WHERE changes() = 1`,
    )
    .bind(t.id, t.instructionId, t.from, t.to, t.action, t.actor, t.now);
}
