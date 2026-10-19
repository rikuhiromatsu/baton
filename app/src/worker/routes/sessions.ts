// セッションとトランスクリプト（ブラウザ用。DESIGN-v2 8.3・12.2・13.7）
import { Hono } from "hono";
import { PostSessionMessageInput, PostSessionMessageOutput, TranscriptItemSchema, TranscriptOutput, TranscriptQuery } from "@baton/shared";
import { toSessionInput, toTranscriptItem, type AgentSessionRow, type SessionInputRow, type TranscriptRow } from "../db/rows.ts";
import { hubStub, notifyRunners, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { conflict, invalid, notFound } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const sessionRoutes = new Hono<AppEnv>();
export const transcriptItemRoutes = new Hono<AppEnv>();

async function requireAgentSession(db: D1Database, id: string): Promise<AgentSessionRow> {
  const row = await db.prepare("SELECT * FROM agent_sessions WHERE id = ?").bind(id).first<AgentSessionRow>();
  if (!row) throw notFound("session not found");
  return row;
}

sessionRoutes.get("/:id/transcript", async (c) => {
  const q = TranscriptQuery.safeParse({
    after: c.req.query("after") || undefined,
    before: c.req.query("before") || undefined,
    instructionId: c.req.query("instructionId") || undefined,
    limit: c.req.query("limit") || undefined,
  });
  if (!q.success) throw invalid("invalid query");
  const db = c.env.DB;
  const session = await requireAgentSession(db, c.req.param("id"));
  const where = ["session_id = ?"];
  const args: unknown[] = [session.id];
  if (q.data.instructionId) where.push("instruction_id = ?"), args.push(q.data.instructionId);
  let items: TranscriptRow[];
  let hasMoreBefore: boolean;
  if (q.data.after !== undefined) {
    // 続き（after より後を古い順に）
    const { results } = await db
      .prepare(`SELECT * FROM transcript_items WHERE ${where.join(" AND ")} AND seq > ? ORDER BY seq LIMIT ?`)
      .bind(...args, q.data.after, q.data.limit)
      .all<TranscriptRow>();
    items = results;
    const older = await db
      .prepare(`SELECT 1 AS ok FROM transcript_items WHERE ${where.join(" AND ")} AND seq <= ? LIMIT 1`)
      .bind(...args, q.data.after)
      .first();
    hasMoreBefore = older !== null;
  } else {
    // 最新（before より前）の limit 件を古い順に
    const before = q.data.before ?? Number.MAX_SAFE_INTEGER;
    const { results } = await db
      .prepare(`SELECT * FROM transcript_items WHERE ${where.join(" AND ")} AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .bind(...args, before, q.data.limit + 1)
      .all<TranscriptRow>();
    hasMoreBefore = results.length > q.data.limit;
    items = results.slice(0, q.data.limit).reverse();
  }
  return c.json(checked(c.env, TranscriptOutput, { items: items.map(toTranscriptItem), hasMoreBefore }));
});

/** メンバーへの追加の依頼（5.6・D-54）。COO・リーダーへはスレッドへの発言で送る */
sessionRoutes.post("/:id/messages", async (c) => {
  const input = await readJson(c, PostSessionMessageInput);
  const db = c.env.DB;
  const existing = await db.prepare("SELECT * FROM session_inputs WHERE client_id = ?").bind(input.clientId).first<SessionInputRow>();
  if (existing) return c.json(checked(c.env, PostSessionMessageOutput, { input: toSessionInput(existing) }), 200);
  const session = await requireAgentSession(db, c.req.param("id"));
  if (session.role !== "member" || !session.instruction_id) throw invalid("follow-ups go to member sessions only");
  const inst = await db.prepare("SELECT status FROM instructions WHERE id = ?").bind(session.instruction_id).first<{ status: string }>();
  // 届けられる（claim で拾える）状態の指示だけ受け付ける。終わった指示はリーダーとの会話で再開する
  if (!inst || !["running", "needs_decision", "review"].includes(inst.status)) throw conflict("instruction is not active", { status: inst?.status });
  const now = Date.now();
  const id = newId();
  await db
    .prepare(
      `INSERT INTO session_inputs (id, client_id, session_id, instruction_id, body, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(client_id) DO NOTHING`,
    )
    .bind(id, input.clientId, session.id, session.instruction_id, input.body, c.get("user").id, now)
    .run();
  const row = (await db.prepare("SELECT * FROM session_inputs WHERE client_id = ?").bind(input.clientId).first<SessionInputRow>())!;
  const view = toSessionInput(row);
  await publish(c.env, [{ t: "session_input.upserted", input: view }]);
  await notifyRunners(c.env, [{ t: "session.input", sessionId: session.id, inputId: row.id }, { t: "work.available" }]);
  return c.json(checked(c.env, PostSessionMessageOutput, { input: view }), row.id === id ? 202 : 200);
});

sessionRoutes.post("/:id/interrupt", async (c) => {
  const session = await requireAgentSession(c.env.DB, c.req.param("id"));
  const requestId = await hubStub(c.env).addInterrupt("session", session.id);
  await notifyRunners(c.env, [{ t: "session.interrupt", sessionId: session.id, requestId }]);
  return c.body(null, 202);
});

transcriptItemRoutes.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM transcript_items WHERE id = ?").bind(c.req.param("id")).first<TranscriptRow>();
  if (!row) throw notFound("transcript item not found");
  return c.json(checked(c.env, TranscriptItemSchema, toTranscriptItem(row)));
});
