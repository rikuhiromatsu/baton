// 会話への書き込み（CEO・秘書の発言、会話の区切り）。ブラウザ・秘書 bot・遷移から共通で使う（DESIGN-v2 4・11 章）
import { CONVERSATION_BREAK_TEXT, COO_THREAD_ID, LIMITS, type ThreadMessage } from "@baton/shared";
import { conversationBreakMs, type Env } from "../env.ts";
import { getProject } from "../db/projects.ts";
import { getMessage, getThread, inboxInsertStatements, messageInsertStatements, requireThread } from "../db/threads.ts";
import type { ThreadRow } from "../db/rows.ts";
import { afterMessages, instructionEvents, notifyRunners, publish } from "../hub/broadcast.ts";
import { ApiError, invalid } from "../lib/errors.ts";

export type PostedMessage = { message: ThreadMessage; created: boolean };

async function existingByClientId(db: D1Database, clientId: string): Promise<ThreadMessage | null> {
  const row = await db.prepare("SELECT id FROM thread_messages WHERE client_id = ?").bind(clientId).first<{ id: string }>();
  return row ? getMessage(db, row.id) : null;
}

/** 受信箱に入ったあと、動いているターンへ流すか、ランナーに仕事を知らせる（4.5） */
async function wakeRunner(env: Env, threadId: string, inboxId: string): Promise<void> {
  const thread = await getThread(env.DB, threadId);
  if (thread?.status === "running") await notifyRunners(env, [{ t: "thread.input", threadId, inboxId }]);
  else await notifyRunners(env, [{ t: "work.available" }]);
}

/** CEO の発言（POST /api/threads/:id/messages。差し戻しのコメントも）。clientId で冪等 */
export async function postCeoMessage(
  env: Env,
  input: { threadId: string; userId: string; clientId: string | null; body: string; contextProjectId?: string; instructionId?: string; sendBack?: boolean },
): Promise<PostedMessage> {
  const db = env.DB;
  if (input.clientId) {
    const existing = await existingByClientId(db, input.clientId);
    if (existing) return { message: existing, created: false };
  }
  await requireThread(db, input.threadId);
  if (input.instructionId) {
    const ok = await db.prepare("SELECT 1 AS ok FROM instructions WHERE id = ?").bind(input.instructionId).first();
    if (!ok) throw invalid("instruction not found");
  }
  let contextProjectName: string | undefined;
  if (input.contextProjectId) {
    const project = await getProject(db, input.contextProjectId);
    if (!project) throw invalid("project not found");
    contextProjectName = project.name;
  }
  const now = Date.now();
  // レート制限: CEO の発言は 1 分 30 件（v1 6.6 を発言に）
  const recent = await db
    .prepare("SELECT count(*) AS n FROM thread_messages WHERE author_kind = 'ceo' AND created_at > ?")
    .bind(now - 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LIMITS.ceoMessagesPerMinute) throw new ApiError("rate_limited", "too many messages", { retryAfterMs: 60_000 });

  const ref: Record<string, unknown> = {};
  if (input.contextProjectId) ref.contextProjectId = input.contextProjectId;
  if (input.sendBack) ref.notice = "send_back";
  const msg = messageInsertStatements(
    db,
    {
      threadId: input.threadId,
      clientId: input.clientId,
      authorKind: "ceo",
      kind: "chat",
      body: input.body,
      instructionId: input.instructionId ?? null,
      ref,
      notify: false,
    },
    now,
  );
  const payload: Record<string, unknown> = { body: input.body };
  if (contextProjectName) payload.contextProjectName = contextProjectName;
  if (input.sendBack) payload.sendBack = true;
  const inbox = inboxInsertStatements(
    db,
    { threadId: input.threadId, kind: "ceo_message", wakes: true, messageId: msg.id, instructionId: input.instructionId ?? null, payload },
    now,
  );
  try {
    await db.batch([
      ...msg.stmts,
      ...inbox.stmts,
      // CEO が返事をしたので「返事待ち」を外す。自分の発言までは既読
      db.prepare("UPDATE threads SET awaiting_reply = 0 WHERE id = ?").bind(input.threadId),
      db
        .prepare(
          `INSERT INTO thread_reads (user_id, thread_id, last_read_seq, updated_at)
           SELECT ?1, ?2, m.seq, ?3 FROM thread_messages m WHERE m.id = ?4
           ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_seq = max(last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at`,
        )
        .bind(input.userId, input.threadId, now, msg.id),
    ]);
  } catch (err) {
    if (input.clientId && /UNIQUE/i.test(String(err))) {
      const existing = await existingByClientId(db, input.clientId);
      if (existing) return { message: existing, created: false };
    }
    throw err;
  }
  const [message] = await afterMessages(env, [msg.id], { push: false });
  if (input.instructionId) await publish(env, await instructionEvents(env, [input.instructionId]));
  await wakeRunner(env, input.threadId, inbox.id);
  return { message: message!, created: true };
}

/** 秘書 bot の発言（baton_send_to_coo。11.4・11.5）。client_id は bot:<tokenId>:<requestId> で冪等 */
export async function postSecretaryMessage(
  env: Env,
  input: { tokenId: string; requestId: string; body: string; projectId?: string },
): Promise<PostedMessage> {
  const db = env.DB;
  const clientId = `bot:${input.tokenId}:${input.requestId}`;
  const existing = await existingByClientId(db, clientId);
  if (existing) return { message: existing, created: false };
  let contextProjectName: string | undefined;
  if (input.projectId) {
    const project = await getProject(db, input.projectId);
    if (!project) throw invalid("project not found");
    contextProjectName = project.name;
  }
  const now = Date.now();
  const msg = messageInsertStatements(
    db,
    {
      threadId: COO_THREAD_ID,
      clientId,
      authorKind: "secretary",
      kind: "chat",
      body: input.body,
      ref: input.projectId ? { contextProjectId: input.projectId } : {},
      notify: false,
      botTokenId: input.tokenId,
    },
    now,
  );
  const payload: Record<string, unknown> = { body: input.body };
  if (contextProjectName) payload.contextProjectName = contextProjectName;
  const inbox = inboxInsertStatements(db, { threadId: COO_THREAD_ID, kind: "secretary_message", wakes: true, messageId: msg.id, payload }, now);
  try {
    await db.batch([...msg.stmts, ...inbox.stmts]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) {
      const again = await existingByClientId(db, clientId);
      if (again) return { message: again, created: false };
    }
    throw err;
  }
  const [message] = await afterMessages(env, [msg.id], { push: false });
  await notifyRunners(env, [{ t: "work.available" }]);
  return { message: message!, created: true };
}

/**
 * 会話の区切り（4.6）。CEO がリーダーのスレッドを離れた、または最後の発言から 15 分。
 * 相づち（ack）以外で、最後の leader_report・区切りより後の CEO の発言があれば、リーダーの受信箱に区切りを入れてターンを起こす。
 * idleMs を渡すと、最後の CEO の発言からその時間がたっていないときは何もしない。
 */
export async function maybeConversationBreak(env: Env, thread: ThreadRow, now: number, opts: { idleMs?: number } = {}): Promise<boolean> {
  if (thread.kind !== "leader") return false;
  const db = env.DB;
  const row = await db
    .prepare(
      `WITH marks AS (
         SELECT max(
           COALESCE((SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = ?2 AND m.kind = 'leader_report'
                       AND (m.author_agent_id = ?3 OR json_extract(m.ref, '$.threadId') = ?1)), 0),
           COALESCE((SELECT max(x.created_at) FROM thread_inbox x WHERE x.thread_id = ?1 AND x.kind = 'instruction_event'
                       AND json_extract(x.payload, '$.type') = 'conversation_break'), 0)) AS since)
       SELECT
         (SELECT count(*) FROM thread_inbox x WHERE x.thread_id = ?1 AND x.status = 'pending'
            AND (x.kind = 'ceo_message' OR (x.kind = 'instruction_event' AND json_extract(x.payload, '$.type') = 'conversation_break'))) AS pending,
         (SELECT count(*) FROM thread_messages m, marks WHERE m.thread_id = ?1 AND m.author_kind = 'ceo' AND m.kind = 'chat'
            AND m.reaction IS NULL AND m.created_at > marks.since) AS unreported,
         (SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = ?1 AND m.author_kind = 'ceo') AS last_ceo_at`,
    )
    .bind(thread.id, COO_THREAD_ID, thread.agent_id ?? "")
    .first<{ pending: number; unreported: number; last_ceo_at: number | null }>();
  if (!row || row.pending > 0 || row.unreported === 0) return false;
  if (opts.idleMs !== undefined && now - (row.last_ceo_at ?? now) < opts.idleMs) return false;
  const inbox = inboxInsertStatements(
    db,
    { threadId: thread.id, kind: "instruction_event", wakes: true, payload: { type: "conversation_break", text: CONVERSATION_BREAK_TEXT } },
    now,
  );
  await db.batch(inbox.stmts);
  await notifyRunners(env, [{ t: "work.available" }]);
  return true;
}

/** claim のついでに、15 分たった会話の区切りを探す（Cron は使わない） */
export async function scanConversationBreaks(env: Env, now: number): Promise<void> {
  const idleMs = conversationBreakMs(env, LIMITS.conversationBreakMs);
  const { results } = await env.DB.prepare(
    `SELECT t.* FROM threads t WHERE t.kind = 'leader' AND t.status = 'idle'
       AND EXISTS (SELECT 1 FROM thread_messages m WHERE m.thread_id = t.id AND m.author_kind = 'ceo' AND m.created_at <= ?)`,
  )
    .bind(now - idleMs)
    .all<ThreadRow>();
  for (const t of results) await maybeConversationBreak(env, t, now, { idleMs });
}
