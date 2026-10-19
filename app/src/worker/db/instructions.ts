// 指示のリポジトリ（v1 設計書 3.2・4.2・7.3、DESIGN-v2 4.4・12.6）
import { HOME_STATUS_ORDER, LIMITS, RECENT_DAYS_FOR_CLOSED, type InstructionSummary } from "@baton/shared";
import { DAY_MS } from "../lib/time.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { toSummary, type ActiveAgentRef, type InstructionRow, type InstructionSummaryRow } from "./rows.ts";

/** 動いているとみなすメンバーのセッションの状態 */
export const LIVE_SESSION_STATUSES = "('pending','running','awaiting_approval')";

/** 一覧と同じ形の行を作る SELECT。taskCounts は work タスクだけを数える */
export const SUMMARY_SELECT = `
SELECT i.*,
  p.name AS project_name,
  (SELECT d.id FROM decisions d WHERE d.instruction_id = i.id AND d.status = 'open'
     ORDER BY d.created_at DESC LIMIT 1) AS open_decision_id,
  (SELECT count(*) FROM decisions d WHERE d.instruction_id = i.id AND d.status = 'open') AS open_decision_count,
  (SELECT count(*) FROM agent_sessions s WHERE s.instruction_id = i.id AND s.role = 'member' AND s.status IN ${LIVE_SESSION_STATUSES}) AS active_session_count,
  COALESCE(
    (SELECT s.activity FROM agent_sessions s WHERE s.instruction_id = i.id AND s.role = 'member'
       AND s.status IN ('running','awaiting_approval') AND s.activity IS NOT NULL ORDER BY s.activity_at DESC LIMIT 1),
    CASE i.phase
      WHEN 'leader' THEN (SELECT s.activity FROM threads t JOIN agent_sessions s ON s.id = t.current_session_id
                            WHERE t.kind = 'leader' AND t.project_id = i.project_id AND t.status = 'running')
      WHEN 'coo' THEN (SELECT s.activity FROM threads t JOIN agent_sessions s ON s.id = t.current_session_id
                         WHERE t.kind = 'coo' AND t.status = 'running')
    END) AS session_activity,
  (SELECT count(*) FROM thread_inbox x JOIN threads t ON t.id = x.thread_id
     WHERE t.kind = 'leader' AND t.project_id = i.project_id AND x.kind = 'ceo_message' AND x.status = 'pending') AS talking,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work') AS tc_total,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work' AND t.status = 'done') AS tc_done,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work' AND t.status = 'running') AS tc_running,
  (SELECT count(*) FROM tasks t WHERE t.instruction_id = i.id AND t.kind = 'work' AND t.status = 'failed') AS tc_failed
FROM instructions i
LEFT JOIN projects p ON p.id = i.project_id`;

/** ホームの並び（status の順位） */
const STATUS_RANK_SQL = `CASE i.status ${HOME_STATUS_ORDER.map((s, n) => `WHEN '${s}' THEN ${n}`).join(" ")} ELSE 99 END`;

export async function getInstructionRow(db: D1Database, id: string): Promise<InstructionRow | null> {
  return db.prepare("SELECT * FROM instructions WHERE id = ?").bind(id).first<InstructionRow>();
}

export async function requireInstruction(db: D1Database, id: string): Promise<InstructionRow> {
  const row = await getInstructionRow(db, id);
  if (!row) throw notFound("instruction not found");
  return row;
}

/** 動いているエージェントの頭文字（13.8。メンバーのセッション、段階に応じてリーダー・COO） */
async function activeAgentsFor(db: D1Database, rows: InstructionSummaryRow[]): Promise<Map<string, ActiveAgentRef[]>> {
  const out = new Map<string, ActiveAgentRef[]>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");
  const [sessions, threads] = await db.batch([
    db
      .prepare(
        `SELECT s.instruction_id, a.id AS agent_id, a.name, a.role FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
          WHERE s.instruction_id IN (${ph}) AND s.role = 'member' AND s.status IN ${LIVE_SESSION_STATUSES} ORDER BY s.created_at`,
      )
      .bind(...ids),
    db.prepare(
      `SELECT t.kind, t.project_id, a.id AS agent_id, a.name, a.role FROM threads t JOIN agents a ON a.id = t.agent_id WHERE t.status = 'running'`,
    ),
  ]);
  const running = (threads?.results ?? []) as { kind: string; project_id: string | null; agent_id: string; name: string; role: ActiveAgentRef["role"] }[];
  for (const r of rows) {
    const list: ActiveAgentRef[] = [];
    const add = (a: ActiveAgentRef) => {
      if (!list.some((x) => x.agentId === a.agentId)) list.push(a);
    };
    if (r.status === "running" || r.status === "queued") {
      const th =
        r.phase === "coo"
          ? running.find((t) => t.kind === "coo")
          : r.phase === "leader"
            ? running.find((t) => t.kind === "leader" && t.project_id === r.project_id)
            : undefined;
      if (th) add({ agentId: th.agent_id, name: th.name, role: th.role });
    }
    for (const s of (sessions?.results ?? []) as { instruction_id: string; agent_id: string; name: string; role: ActiveAgentRef["role"] }[]) {
      if (s.instruction_id === r.id) add({ agentId: s.agent_id, name: s.name, role: s.role });
    }
    out.set(r.id, list.slice(0, 3));
  }
  return out;
}

export async function summariesFromRows(db: D1Database, rows: InstructionSummaryRow[]): Promise<InstructionSummary[]> {
  const agents = await activeAgentsFor(db, rows);
  return rows.map((r) => toSummary(r, agents.get(r.id) ?? []));
}

export async function getSummaryRow(db: D1Database, id: string): Promise<InstructionSummaryRow | null> {
  return db.prepare(`${SUMMARY_SELECT} WHERE i.id = ?`).bind(id).first<InstructionSummaryRow>();
}

export async function getSummary(db: D1Database, id: string): Promise<InstructionSummary | null> {
  const row = await getSummaryRow(db, id);
  return row ? (await summariesFromRows(db, [row]))[0]! : null;
}

export async function getSummaries(db: D1Database, ids: string[]): Promise<InstructionSummary[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`${SUMMARY_SELECT} WHERE i.id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<InstructionSummaryRow>();
  return summariesFromRows(db, results);
}

/** カーソルは「何件目から」の数字（個人用で件数が少ないため、オフセットで十分） */
export async function listInstructions(
  db: D1Database,
  q: { view: "active" | "archived"; projectId?: string; cursor?: string },
  now: number,
): Promise<{ items: InstructionSummary[]; nextCursor: string | null }> {
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const limit = LIMITS.pageSize;
  const projectSql = q.projectId ? "AND i.project_id = ?" : "";
  const projectArgs = q.projectId ? [q.projectId] : [];
  let stmt: D1PreparedStatement;
  if (q.view === "archived") {
    stmt = db
      .prepare(`${SUMMARY_SELECT} WHERE i.status = 'archived' ${projectSql} ORDER BY i.status_changed_at DESC, i.id LIMIT ? OFFSET ?`)
      .bind(...projectArgs, limit + 1, offset);
  } else {
    const closedSince = now - RECENT_DAYS_FOR_CLOSED * DAY_MS;
    stmt = db
      .prepare(
        `${SUMMARY_SELECT}
         WHERE i.status <> 'archived'
           AND (i.status NOT IN ('done','canceled') OR i.status_changed_at >= ?)
           ${projectSql}
         ORDER BY ${STATUS_RANK_SQL}, i.status_changed_at DESC, i.id
         LIMIT ? OFFSET ?`,
      )
      .bind(closedSince, ...projectArgs, limit + 1, offset);
  }
  const { results } = await stmt.all<InstructionSummaryRow>();
  const hasMore = results.length > limit;
  return {
    items: await summariesFromRows(db, results.slice(0, limit)),
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

/**
 * ランナーが指示に書き込んでよい条件（D-36 の lease を INSERT・UPDATE の条件に入れる）。
 * v2 ではスレッドのターン（リーダーの plan、COO の present）も指示に書くので、
 * 「他のランナーが有効な lease を握っていない」かつ「終わっていない」を条件にする。
 * 引数は番号付きの ?（idParam: 指示 ID、runnerParam: ランナー ID、nowParam: 現在時刻）。
 */
export function writableSql(alias: string, runnerParam: string, nowParam: string): string {
  return `${alias}.status IN ('queued','running','needs_decision','review','done')
    AND (${alias}.lease_runner_id IS NULL OR ${alias}.lease_runner_id = ${runnerParam} OR ${alias}.lease_expires_at < ${nowParam})`;
}

export function isWritableBy(row: InstructionRow, runnerId: string, now: number): boolean {
  if (!["queued", "running", "needs_decision", "review", "done"].includes(row.status)) return false;
  return row.lease_runner_id === null || row.lease_runner_id === runnerId || (row.lease_expires_at ?? 0) < now;
}

/** ランナーの書き込みの前の検査（409: 他のランナーが握っている・終わっている） */
export async function requireWritable(db: D1Database, id: string, runnerId: string, now = Date.now()): Promise<InstructionRow> {
  const row = await requireInstruction(db, id);
  if (!isWritableBy(row, runnerId, now)) throw conflict("lease not held", { status: row.status });
  return row;
}

/** lease を握っていること（claim した instruction・finalize の処理） */
export async function requireLease(db: D1Database, id: string, runnerId: string, now = Date.now()): Promise<InstructionRow> {
  const row = await requireInstruction(db, id);
  if (row.lease_runner_id !== runnerId || (row.lease_expires_at ?? 0) < now) throw conflict("lease not held", { status: row.status });
  return row;
}
