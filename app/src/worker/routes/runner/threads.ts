// ランナーの会話の書き込み: 発言・ストリーム・受信箱・ターンの終わり・プロジェクト案・プロジェクト（DESIGN-v2 4.5〜4.7・12.3）
import { Hono } from "hono";
import {
  COO_AGENT_ID,
  InboxItemSchema,
  ProjectProposalSchema,
  RunnerCreateProjectInput,
  RunnerCreateProjectOutput,
  RunnerCreateProposalInput,
  RunnerInboxInput,
  RunnerPatchMessageInput,
  RunnerPostMessageInput,
  RunnerPostMessageOutput,
  StreamInput,
  ThreadReleaseInput,
  TurnDoneInput,
  type ServerEvent,
} from "@baton/shared";
import { createProjectWithTeam } from "../../db/projects.ts";
import { toMessage, type InboxRow, type MessageRow, type ThreadRow } from "../../db/rows.ts";
import { getMessage, getMessageRow, inboxInsertStatements, messageInsertStatements, requireThread } from "../../db/threads.ts";
import { afterMessages, instructionEvents, isNotifiable, messageEvent, notifyRunners, projectEvents, publish, threadEvents } from "../../hub/broadcast.ts";
import { parseObject } from "../../lib/json.ts";
import { conflict, invalid, notFound } from "../../lib/errors.ts";
import { checked, readJson } from "../../lib/validate.ts";
import { getProposal, requireRepoCandidate } from "../../services/projects.ts";
import type { AppEnv } from "../../types.ts";

export const runnerThreadRoutes = new Hono<AppEnv>();

/** 他のランナーが有効な lease を握っているスレッドには書かない */
function assertNotHeldByOther(thread: ThreadRow, runnerId: string, now: number): void {
  if (thread.lease_runner_id && thread.lease_runner_id !== runnerId && (thread.lease_expires_at ?? 0) >= now) {
    throw conflict("thread lease held by another runner");
  }
}

/** ターンを回している（lease を握っている）こと */
function assertHeld(thread: ThreadRow, runnerId: string): void {
  if (thread.status !== "running" || thread.lease_runner_id !== runnerId) throw conflict("thread lease not held", { status: thread.status });
}

const NOTIFY_KINDS = new Set(["chat", "report", "project_proposal"]);

runnerThreadRoutes.post("/threads/:id/messages", async (c) => {
  const input = await readJson(c, RunnerPostMessageInput);
  const db = c.env.DB;
  const now = Date.now();
  const thread = await requireThread(db, c.req.param("id"));
  const existing = await getMessage(db, input.id);
  if (existing) {
    if (existing.threadId !== thread.id) throw conflict("message id belongs to another thread");
    return c.json(checked(c.env, RunnerPostMessageOutput, { message: existing }), 200);
  }
  assertNotHeldByOther(thread, c.get("runner").id, now);
  if (input.instructionId) {
    const ok = await db.prepare("SELECT 1 AS ok FROM instructions WHERE id = ?").bind(input.instructionId).first();
    if (!ok) throw invalid("instruction not found");
  }
  const authorAgentId = input.authorAgentId ?? (input.authorKind === "coo" ? COO_AGENT_ID : input.authorKind === "leader" ? thread.agent_id : null);
  // 未読・通知に数えるのは COO・リーダーの chat・report・project_proposal だけ（4.3・4.8）
  const notify = input.notify && input.authorKind !== "system" && NOTIFY_KINDS.has(input.kind);
  const msg = messageInsertStatements(
    db,
    {
      id: input.id,
      threadId: thread.id,
      authorKind: input.authorKind,
      authorAgentId,
      kind: input.kind,
      body: input.body,
      instructionId: input.instructionId,
      sessionId: input.sessionId,
      ref: input.ref,
      status: input.status,
      notify,
    },
    now,
  );
  try {
    await db.batch(msg.stmts);
  } catch (err) {
    if (/UNIQUE|PRIMARY/i.test(String(err))) {
      const again = await getMessage(db, input.id);
      if (again) return c.json(checked(c.env, RunnerPostMessageOutput, { message: again }), 200);
    }
    if (/FOREIGN KEY/i.test(String(err))) throw invalid("referenced row not found");
    throw err;
  }
  const [message] = await afterMessages(c.env, [msg.id]);
  return c.json(checked(c.env, RunnerPostMessageOutput, { message: message! }), 201);
});

runnerThreadRoutes.patch("/threads/:id/messages/:mid", async (c) => {
  const input = await readJson(c, RunnerPatchMessageInput);
  const db = c.env.DB;
  const thread = await requireThread(db, c.req.param("id"));
  const row = await getMessageRow(db, c.req.param("mid"));
  if (!row || row.thread_id !== thread.id) throw notFound("message not found");
  assertNotHeldByOther(thread, c.get("runner").id, Date.now());
  if (row.author_kind === "ceo" || row.author_kind === "secretary") throw conflict("cannot edit CEO or secretary messages");
  const now = Date.now();
  if (input.delete) {
    // 本文も行動も無かった空の発言（4.7）。画面には canceled・deleted で知らせて消してもらう
    await db.prepare("DELETE FROM thread_messages WHERE id = ?").bind(row.id).run();
    const gone = { ...toDeleted(row), updatedAt: now };
    await publish(c.env, [messageEvent(gone), ...(await threadEvents(c.env, [thread.id]))]);
    return c.body(null, 204);
  }
  if (input.instructionId) {
    const ok = await db.prepare("SELECT 1 AS ok FROM instructions WHERE id = ?").bind(input.instructionId).first();
    if (!ok) throw invalid("instruction not found");
  }
  const sets = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.body !== undefined) sets.push("body = ?"), args.push(input.body);
  if (input.kind !== undefined) sets.push("kind = ?"), args.push(input.kind);
  if (input.status !== undefined) sets.push("status = ?"), args.push(input.status);
  if (input.instructionId !== undefined) sets.push("instruction_id = ?"), args.push(input.instructionId);
  if (input.ref !== undefined) sets.push("ref = ?"), args.push(JSON.stringify(input.ref));
  const kind = input.kind ?? row.kind;
  if (input.notify !== undefined) sets.push("notify = ?"), args.push(input.notify && row.author_kind !== "system" && NOTIFY_KINDS.has(kind) ? 1 : 0);
  await db.prepare(`UPDATE thread_messages SET ${sets.join(", ")} WHERE id = ?`).bind(...args, row.id).run();
  const message = (await getMessage(db, row.id))!;
  // 完成した瞬間（streaming → complete）だけ通知の候補にする
  const becameComplete = row.status !== "complete" && message.status === "complete";
  await afterMessages(c.env, [row.id], { push: becameComplete && isNotifiable(message) });
  return c.json(checked(c.env, RunnerPostMessageOutput, { message }));
});

function toDeleted(row: MessageRow) {
  return { ...toMessage(row), body: "", status: "canceled" as const, ref: { ...parseObject(row.ref), deleted: true } };
}

/** ストリームの差分（D1 に書かない。開いているブラウザにだけ。4.7） */
runnerThreadRoutes.post("/threads/:id/stream", async (c) => {
  const input = await readJson(c, StreamInput);
  const ev: ServerEvent = {
    t: "message.delta",
    threadId: c.req.param("id"),
    messageId: input.messageId,
    offset: input.offset,
    delta: input.delta,
    ...(input.reset !== undefined ? { reset: input.reset } : {}),
    ...(input.activity !== undefined ? { activity: input.activity } : {}),
  };
  await publish(c.env, [ev]);
  return c.body(null, 204);
});

runnerThreadRoutes.post("/threads/:id/inbox", async (c) => {
  const input = await readJson(c, RunnerInboxInput);
  const db = c.env.DB;
  const thread = await requireThread(db, c.req.param("id"));
  const now = Date.now();
  const inbox = inboxInsertStatements(
    db,
    { threadId: thread.id, kind: input.kind, wakes: input.wakes, messageId: input.messageId ?? null, instructionId: input.instructionId ?? null, payload: input.payload },
    now,
  );
  try {
    await db.batch(inbox.stmts);
  } catch (err) {
    if (/FOREIGN KEY/i.test(String(err))) throw invalid("referenced row not found");
    throw err;
  }
  const row = (await db.prepare("SELECT * FROM thread_inbox WHERE id = ?").bind(inbox.id).first<InboxRow>())!;
  if (input.wakes) {
    await publish(c.env, await threadEvents(c.env, [thread.id]));
    await notifyRunners(c.env, [{ t: "work.available" }]);
  }
  return c.json(
    checked(c.env, InboxItemSchema, {
      id: row.id,
      threadId: row.thread_id,
      kind: input.kind,
      wakes: row.wakes === 1,
      messageId: row.message_id,
      instructionId: row.instruction_id,
      payload: parseObject(row.payload),
      createdAt: row.created_at,
    }),
    201,
  );
});

const ph = (ids: readonly unknown[]) => ids.map(() => "?").join(",");

/** ターンの終わり: 受信箱の消化、相づちの ack、返事待ち、lease を外す（4.5・D-77） */
runnerThreadRoutes.post("/threads/:id/turn-done", async (c) => {
  const input = await readJson(c, TurnDoneInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const thread = await requireThread(db, c.req.param("id"));
  assertHeld(thread, runnerId);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  // どの書き込みも、このランナーが今もターンを回しているときだけ当たる（途中で取り直されたら何も変えない）
  const held = `EXISTS (SELECT 1 FROM threads h WHERE h.id = '${thread.id.replaceAll("'", "''")}' AND h.lease_runner_id = '${runnerId.replaceAll("'", "''")}' AND h.status = 'running')`;
  if (input.consumedInboxIds.length > 0) {
    stmts.push(
      db
        .prepare(`UPDATE thread_inbox SET status = 'consumed', consumed_at = ? WHERE thread_id = ? AND status = 'pending' AND id IN (${ph(input.consumedInboxIds)}) AND ${held}`)
        .bind(now, thread.id, ...input.consumedInboxIds),
    );
  }
  if (input.ackMessageIds.length > 0) {
    stmts.push(
      db
        .prepare(`UPDATE thread_messages SET reaction = 'ack', updated_at = ? WHERE thread_id = ? AND author_kind = 'ceo' AND id IN (${ph(input.ackMessageIds)}) AND ${held}`)
        .bind(now, thread.id, ...input.ackMessageIds),
    );
  }
  if (input.numTurns > 0) {
    stmts.push(db.prepare(`UPDATE agent_sessions SET turns = turns + ?, updated_at = ? WHERE id = ? AND thread_id = ? AND ${held}`).bind(input.numTurns, now, input.sessionId, thread.id));
  }
  stmts.push(
    db
      .prepare(
        `UPDATE threads SET awaiting_reply = ?, lease_runner_id = NULL, lease_expires_at = NULL, updated_at = ?,
           status = CASE WHEN EXISTS (SELECT 1 FROM thread_inbox x WHERE x.thread_id = threads.id AND x.status = 'pending' AND x.wakes = 1) THEN 'queued' ELSE 'idle' END
         WHERE id = ? AND lease_runner_id = ? AND status = 'running'`,
      )
      .bind(input.awaitingReply ? 1 : 0, now, thread.id, runnerId),
  );
  const results = await db.batch(stmts);
  if (results[results.length - 1]?.meta.changes !== 1) throw conflict("thread lease not held");
  const after = (await db.prepare("SELECT * FROM threads WHERE id = ?").bind(thread.id).first<ThreadRow>())!;
  const events: ServerEvent[] = [];
  for (const id of input.ackMessageIds) {
    const m = await getMessage(db, id);
    if (m) events.push(messageEvent(m));
  }
  events.push(...(await threadEvents(c.env, [thread.id])));
  // 話し中（talkingWithCeo）が変わるので、そのプロジェクトの開いている指示も配り直す
  if (thread.kind === "leader" && thread.project_id) events.push(...(await openInstructionEvents(c.env, thread.project_id)));
  await publish(c.env, events);
  if (after.status === "queued") await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.body(null, 204);
});

async function openInstructionEvents(env: AppEnv["Bindings"], projectId: string): Promise<ServerEvent[]> {
  const { results } = await env.DB.prepare("SELECT id FROM instructions WHERE project_id = ? AND status IN ('queued','running','needs_decision','review')")
    .bind(projectId)
    .all<{ id: string }>();
  return instructionEvents(env, results.map((r) => r.id));
}

/** ターンをやめて lease を外す（枠切れ・停止・失敗。9.2） */
runnerThreadRoutes.post("/threads/:id/release", async (c) => {
  const input = await readJson(c, ThreadReleaseInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const thread = await requireThread(db, c.req.param("id"));
  assertHeld(thread, runnerId);
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE threads SET lease_runner_id = NULL, lease_expires_at = NULL, not_before = ?, updated_at = ?,
         status = CASE WHEN EXISTS (SELECT 1 FROM thread_inbox x WHERE x.thread_id = threads.id AND x.status = 'pending' AND x.wakes = 1) THEN 'queued' ELSE 'idle' END
       WHERE id = ? AND lease_runner_id = ? AND status = 'running'`,
    )
    .bind(input.notBefore, now, thread.id, runnerId)
    .run();
  if (res.meta.changes !== 1) throw conflict("thread lease not held");
  await publish(c.env, await threadEvents(c.env, [thread.id]));
  if (input.notBefore === null || input.notBefore <= now) await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.body(null, 204);
});

// ───────────── プロジェクト案・プロジェクト（3.2） ─────────────

/** COO の propose_project。repoPath は候補にあるものだけ（無ければランナーが baton に直して出す） */
runnerThreadRoutes.post("/project-proposals", async (c) => {
  const input = await readJson(c, RunnerCreateProposalInput);
  const db = c.env.DB;
  const existing = await getProposal(db, input.id);
  if (existing) return c.json(checked(c.env, ProjectProposalSchema, existing), 200);
  await requireThread(db, input.threadId);
  if (input.workspace.kind === "repo") await requireRepoCandidate(db, input.workspace.repoPath);
  if (input.messageId) {
    const m = await getMessageRow(db, input.messageId);
    if (!m || m.thread_id !== input.threadId) throw invalid("message not found in thread");
  }
  const now = Date.now();
  const payload = {
    name: input.name,
    slug: input.slug,
    goal: input.goal,
    summary: input.summary,
    workspace: input.workspace,
    leader: input.leader,
    members: input.members,
  };
  const superseded = await db
    .prepare("SELECT id FROM project_proposals WHERE thread_id = ? AND status = 'pending' AND json_extract(payload, '$.slug') = ?")
    .bind(input.threadId, input.slug)
    .all<{ id: string }>();
  const stmts: D1PreparedStatement[] = [
    // 同じ slug の古い案は置き換え
    db
      .prepare("UPDATE project_proposals SET status = 'superseded', decided_at = ? WHERE thread_id = ? AND status = 'pending' AND json_extract(payload, '$.slug') = ?")
      .bind(now, input.threadId, input.slug),
    db
      .prepare("INSERT INTO project_proposals (id, thread_id, message_id, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT(id) DO NOTHING")
      .bind(input.id, input.threadId, input.messageId, JSON.stringify(payload), now),
  ];
  if (input.messageId) {
    stmts.push(
      db
        .prepare("UPDATE thread_messages SET kind = 'project_proposal', ref = json_set(ref, '$.proposalId', ?), updated_at = ? WHERE id = ?")
        .bind(input.id, now, input.messageId),
    );
  }
  await db.batch(stmts);
  const proposal = (await getProposal(db, input.id))!;
  const events: ServerEvent[] = [{ t: "project_proposal.upserted", proposal }];
  for (const s of superseded.results) {
    const p = await getProposal(db, s.id);
    if (p) events.push({ t: "project_proposal.upserted", proposal: p });
  }
  await publish(c.env, events);
  if (input.messageId) await afterMessages(c.env, [input.messageId], { push: false });
  return c.json(checked(c.env, ProjectProposalSchema, proposal), 201);
});

/** delegate の new（Baton 専用だけ。D-51） */
runnerThreadRoutes.post("/projects", async (c) => {
  const input = await readJson(c, RunnerCreateProjectInput);
  const now = Date.now();
  const { project, leaderThreadId } = await createProjectWithTeam(
    c.env.DB,
    { name: input.name, slug: input.slug, goal: input.goal, summary: input.summary, workspace: { kind: "baton" }, leader: input.leader, members: input.members },
    now,
  );
  await publish(c.env, [...(await projectEvents(c.env, project.id)), ...(await threadEvents(c.env, [leaderThreadId]))]);
  return c.json(checked(c.env, RunnerCreateProjectOutput, { project, leaderThreadId }), 201);
});
