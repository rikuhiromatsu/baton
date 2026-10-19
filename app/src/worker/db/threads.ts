// 会話（スレッド・発言・受信箱・既読）（DESIGN-v2 4 章）
import { COO_THREAD_ID, LIMITS, type InboxKind, type ThreadMessage, type ThreadSummary } from "@baton/shared";
import { newId } from "../lib/crypto.ts";
import { clip } from "../lib/json.ts";
import { notFound } from "../lib/errors.ts";
import { toMessage, type MessageRow, type ThreadRow } from "./rows.ts";

export async function getThread(db: D1Database, id: string): Promise<ThreadRow | null> {
  return db.prepare("SELECT * FROM threads WHERE id = ?").bind(id).first<ThreadRow>();
}

export async function requireThread(db: D1Database, id: string): Promise<ThreadRow> {
  const t = await getThread(db, id);
  if (!t) throw notFound("thread not found");
  return t;
}

/** 配信用の ThreadSummary の未読を数える利用者（個人用なので最初の利用者。ブラウザの要求では本人） */
export async function primaryUserId(db: D1Database): Promise<string | null> {
  return (await db.prepare("SELECT id FROM users ORDER BY created_at, id LIMIT 1").first<{ id: string }>())?.id ?? null;
}

type ThreadSummaryRow = ThreadRow & {
  project_name: string | null;
  agent_name: string | null;
  session_activity: string | null;
  last_read_seq: number | null;
  unread: number | null;
  lm_author_kind: ThreadMessage["authorKind"] | null;
  lm_body: string | null;
  lm_created_at: number | null;
  talking: number | null;
};

const READ_SEQ = `COALESCE((SELECT r.last_read_seq FROM thread_reads r WHERE r.thread_id = t.id AND r.user_id = ?1), 0)`;

const THREAD_SUMMARY_SELECT = `
SELECT t.*, p.name AS project_name, a.name AS agent_name,
  CASE WHEN t.status = 'running' THEN s.activity END AS session_activity,
  ${READ_SEQ} AS last_read_seq,
  (SELECT count(*) FROM thread_messages m WHERE m.thread_id = t.id AND m.notify = 1 AND m.status = 'complete' AND m.seq > ${READ_SEQ}) AS unread,
  lm.author_kind AS lm_author_kind, lm.body AS lm_body, lm.created_at AS lm_created_at,
  (SELECT count(*) FROM thread_inbox x WHERE x.thread_id = t.id AND x.kind = 'ceo_message' AND x.status = 'pending' AND t.kind = 'leader') AS talking
FROM threads t
LEFT JOIN projects p ON p.id = t.project_id
LEFT JOIN agents a ON a.id = t.agent_id
LEFT JOIN agent_sessions s ON s.id = t.current_session_id
LEFT JOIN thread_messages lm ON lm.id = (SELECT m2.id FROM thread_messages m2 WHERE m2.thread_id = t.id AND m2.status <> 'streaming' ORDER BY m2.seq DESC LIMIT 1)`;

function toThreadSummary(r: ThreadSummaryRow): ThreadSummary {
  return {
    id: r.id,
    kind: r.kind,
    projectId: r.project_id,
    projectName: r.project_name,
    agentName: r.agent_name ?? (r.kind === "coo" ? "COO" : "リーダー"),
    status: r.status,
    activity: r.session_activity,
    awaitingReply: r.awaiting_reply === 1,
    unread: r.unread ?? 0,
    lastMessage:
      r.lm_author_kind && r.lm_created_at !== null
        ? { authorKind: r.lm_author_kind, preview: clip((r.lm_body ?? "").replace(/\s+/g, " ").trim(), LIMITS.summaryPreviewChars), createdAt: r.lm_created_at }
        : null,
    talkingWithCeo: (r.talking ?? 0) > 0,
    lastSeq: r.last_seq,
    lastReadSeq: Math.min(r.last_read_seq ?? 0, r.last_seq),
  };
}

/** COO を先頭に、進行中のプロジェクトのリーダーを最終発言の新しい順 */
export async function listThreadSummaries(db: D1Database, userId: string | null): Promise<ThreadSummary[]> {
  const { results } = await db
    .prepare(
      `${THREAD_SUMMARY_SELECT}
       WHERE t.kind = 'coo' OR p.status = 'active'
       ORDER BY CASE t.kind WHEN 'coo' THEN 0 ELSE 1 END, COALESCE(t.last_message_at, t.created_at) DESC, t.id`,
    )
    .bind(userId ?? "")
    .all<ThreadSummaryRow>();
  return results.map(toThreadSummary);
}

export async function getThreadSummary(db: D1Database, id: string, userId: string | null): Promise<ThreadSummary | null> {
  const row = await db.prepare(`${THREAD_SUMMARY_SELECT} WHERE t.id = ?2`).bind(userId ?? "", id).first<ThreadSummaryRow>();
  return row ? toThreadSummary(row) : null;
}

export const MESSAGE_SELECT = `SELECT m.*, a.name AS author_name FROM thread_messages m LEFT JOIN agents a ON a.id = m.author_agent_id`;

export async function getMessage(db: D1Database, id: string): Promise<ThreadMessage | null> {
  const row = await db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(id).first<MessageRow>();
  return row ? toMessage(row) : null;
}

export async function getMessageRow(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(id).first<MessageRow>();
}

export async function listMessages(
  db: D1Database,
  threadId: string,
  q: { before?: number; limit: number },
): Promise<{ items: ThreadMessage[]; hasMoreBefore: boolean }> {
  const before = q.before ?? Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
    .bind(threadId, before, q.limit + 1)
    .all<MessageRow>();
  const hasMoreBefore = results.length > q.limit;
  return { items: results.slice(0, q.limit).reverse().map(toMessage), hasMoreBefore };
}

export type NewMessage = {
  id?: string;
  threadId: string;
  clientId?: string | null;
  authorKind: ThreadMessage["authorKind"];
  authorAgentId?: string | null;
  kind?: ThreadMessage["kind"];
  body: string;
  instructionId?: string | null;
  sessionId?: string | null;
  ref?: Record<string, unknown>;
  status?: "streaming" | "complete";
  notify?: boolean;
  botTokenId?: string | null;
};

/**
 * 発言を入れる文（seq はスレッドの last_seq を +1 して採番。同じトランザクションで使う）。
 * 1 つ目の UPDATE が当たらなければ（スレッドが無い）INSERT も入らない。
 */
export function messageInsertStatements(db: D1Database, m: NewMessage, now: number): { id: string; stmts: D1PreparedStatement[] } {
  const id = m.id ?? newId();
  return {
    id,
    stmts: [
      db
        .prepare("UPDATE threads SET last_seq = last_seq + 1, last_message_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, m.threadId),
      db
        .prepare(
          `INSERT INTO thread_messages (id, thread_id, seq, client_id, author_kind, author_agent_id, kind, body, instruction_id, session_id, ref,
                                        status, reaction, notify, bot_token_id, created_at, updated_at)
           SELECT ?1, ?2, t.last_seq, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?14, ?14 FROM threads t WHERE t.id = ?2 AND changes() = 1`,
        )
        .bind(
          id,
          m.threadId,
          m.clientId ?? null,
          m.authorKind,
          m.authorAgentId ?? null,
          m.kind ?? "chat",
          clip(m.body, LIMITS.messageBodyMaxChars),
          m.instructionId ?? null,
          m.sessionId ?? null,
          JSON.stringify(m.ref ?? {}),
          m.status ?? "complete",
          m.notify ? 1 : 0,
          m.botTokenId ?? null,
          now,
        ),
    ],
  };
}

export type NewInbox = {
  threadId: string;
  kind: InboxKind;
  wakes: boolean;
  messageId?: string | null;
  instructionId?: string | null;
  payload?: Record<string, unknown>;
};

/** 受信箱に入れ、wakes なら idle のスレッドを queued にする */
export function inboxInsertStatements(db: D1Database, x: NewInbox, now: number): { id: string; stmts: D1PreparedStatement[] } {
  const id = newId();
  const stmts = [
    db
      .prepare(
        `INSERT INTO thread_inbox (id, thread_id, kind, wakes, message_id, instruction_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(id, x.threadId, x.kind, x.wakes ? 1 : 0, x.messageId ?? null, x.instructionId ?? null, JSON.stringify(x.payload ?? {}), now),
  ];
  if (x.wakes) {
    stmts.push(db.prepare("UPDATE threads SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'idle'").bind(now, x.threadId));
  }
  return { id, stmts };
}

/** システムの知らせ（notice）を入れる文 */
export function noticeStatements(
  db: D1Database,
  threadId: string,
  body: string,
  ref: Record<string, unknown>,
  instructionId: string | null,
  now: number,
): { id: string; stmts: D1PreparedStatement[] } {
  return messageInsertStatements(db, { threadId, authorKind: "system", kind: "notice", body, ref, instructionId, notify: false }, now);
}

export { COO_THREAD_ID };
