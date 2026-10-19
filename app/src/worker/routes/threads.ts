// 会話（ブラウザ用。DESIGN-v2 4 章・12.2）
import { Hono } from "hono";
import {
  ListMessagesOutput,
  ListMessagesQuery,
  ListThreadsOutput,
  PostMessageInput,
  PostMessageOutput,
  ReadThreadInput,
  ResetThreadOutput,
  UI_TEXT_V2,
} from "@baton/shared";
import { listMessages, listThreadSummaries, noticeStatements, requireThread } from "../db/threads.ts";
import { afterMessages, hubStub, notifyRunners, publish, threadEvents } from "../hub/broadcast.ts";
import { invalid } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import { maybeConversationBreak, postCeoMessage } from "../services/conversation.ts";
import type { AppEnv } from "../types.ts";

export const threadRoutes = new Hono<AppEnv>();

threadRoutes.get("/", async (c) => {
  const items = await listThreadSummaries(c.env.DB, c.get("user").id);
  return c.json(checked(c.env, ListThreadsOutput, { items }));
});

threadRoutes.get("/:id/messages", async (c) => {
  const q = ListMessagesQuery.safeParse({ before: c.req.query("before") || undefined, limit: c.req.query("limit") || undefined });
  if (!q.success) throw invalid("invalid query");
  const thread = await requireThread(c.env.DB, c.req.param("id"));
  const out = await listMessages(c.env.DB, thread.id, q.data);
  return c.json(checked(c.env, ListMessagesOutput, out));
});

threadRoutes.post("/:id/messages", async (c) => {
  const input = await readJson(c, PostMessageInput);
  const { message, created } = await postCeoMessage(c.env, {
    threadId: c.req.param("id"),
    userId: c.get("user").id,
    clientId: input.clientId,
    body: input.body,
    contextProjectId: input.contextProjectId,
    instructionId: input.instructionId,
  });
  return c.json(checked(c.env, PostMessageOutput, { message }), created ? 201 : 200);
});

threadRoutes.post("/:id/read", async (c) => {
  const input = await readJson(c, ReadThreadInput);
  const db = c.env.DB;
  const thread = await requireThread(db, c.req.param("id"));
  const userId = c.get("user").id;
  const seq = Math.min(input.seq, thread.last_seq);
  await db
    .prepare(
      `INSERT INTO thread_reads (user_id, thread_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_seq = max(last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at`,
    )
    .bind(userId, thread.id, seq, Date.now())
    .run();
  await publish(c.env, await threadEvents(c.env, [thread.id]));
  return c.body(null, 204);
});

/** 会話の区切り（4.6）。未報告の CEO の発言があればリーダーに報告のターンを起こす */
threadRoutes.post("/:id/leave", async (c) => {
  const thread = await requireThread(c.env.DB, c.req.param("id"));
  await maybeConversationBreak(c.env, thread, Date.now());
  return c.body(null, 204);
});

threadRoutes.post("/:id/interrupt", async (c) => {
  const thread = await requireThread(c.env.DB, c.req.param("id"));
  await hubStub(c.env).addInterrupt("thread", thread.id);
  await notifyRunners(c.env, [{ t: "thread.interrupt", threadId: thread.id }]);
  return c.body(null, 202);
});

/** 新しい話題（4.2）。次のターンから新しいセッション。画面には区切りの知らせ */
threadRoutes.post("/:id/reset", async (c) => {
  const db = c.env.DB;
  const thread = await requireThread(db, c.req.param("id"));
  const now = Date.now();
  const notice = noticeStatements(db, thread.id, UI_TEXT_V2.notices.newTopic, { notice: "new_topic" }, null, now);
  await db.batch([db.prepare("UPDATE threads SET current_session_id = NULL, updated_at = ? WHERE id = ?").bind(now, thread.id), ...notice.stmts]);
  const [message] = await afterMessages(c.env, [notice.id], { push: false });
  return c.json(checked(c.env, ResetThreadOutput, { message: message! }));
});
