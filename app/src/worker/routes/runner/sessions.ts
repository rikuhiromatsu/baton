// ランナーのセッション・トランスクリプト・追加の依頼・作業場所・リポジトリ候補（DESIGN-v2 5.3・7.3・8.3・8.4・12.3）
import { Hono } from "hono";
import {
  AppendTranscriptInput,
  AppendTranscriptOutput,
  CreateSessionInput,
  CreateWorkspaceInput,
  LIMITS,
  ListWorkspacesOutput,
  ListWorkspacesQuery,
  PendingInputsOutput,
  PutReposInput,
  SessionInputSchema,
  SessionOutput,
  SessionPatch,
  WorkspacePatch,
  WorkspaceSchema,
  clipForBroadcast,
  type ServerEvent,
  type TranscriptItem,
} from "@baton/shared";
import { requireWritable } from "../../db/instructions.ts";
import {
  toAgentSession,
  toSessionInput,
  toTranscriptItem,
  toWorkspace,
  type AgentSessionRow,
  type SessionInputRow,
  type TranscriptRow,
  type WorkspaceRow,
} from "../../db/rows.ts";
import { requireThread } from "../../db/threads.ts";
import { instructionEvents, publish, threadEvents } from "../../hub/broadcast.ts";
import { conflict, invalid, notFound } from "../../lib/errors.ts";
import { checked, readJson } from "../../lib/validate.ts";
import type { AppEnv } from "../../types.ts";
import type { Env } from "../../env.ts";
import { mapConstraintError } from "./instructions.ts";

export const runnerSessionRoutes = new Hono<AppEnv>();

async function getAgentSession(db: D1Database, id: string): Promise<AgentSessionRow | null> {
  return db.prepare("SELECT * FROM agent_sessions WHERE id = ?").bind(id).first<AgentSessionRow>();
}

/** セッションが変わったら session.upserted と、関わる指示・スレッドを配る */
async function sessionEvents(env: Env, row: AgentSessionRow): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [{ t: "session.upserted", session: toAgentSession(row) }];
  if (row.instruction_id) events.push(...(await instructionEvents(env, [row.instruction_id])));
  if (row.thread_id) events.push(...(await threadEvents(env, [row.thread_id])));
  return events;
}

/** 起動前に作る（ID はランナーが採番して --session-id に渡す。D-44）。冪等 */
runnerSessionRoutes.post("/sessions", async (c) => {
  const input = await readJson(c, CreateSessionInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const existing = await getAgentSession(db, input.id);
  if (existing) return c.json(checked(c.env, SessionOutput, { session: toAgentSession(existing) }), 200);
  if (!input.threadId && !input.instructionId) throw invalid("threadId or instructionId is required");
  if (input.instructionId) await requireWritable(db, input.instructionId, runnerId);
  if (input.threadId) await requireThread(db, input.threadId);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO agent_sessions (id, thread_id, instruction_id, agent_id, role, project_id, task_id, workspace_id, title, cwd, model, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(input.id, input.threadId, input.instructionId, input.agentId, input.role, input.projectId, input.taskId, input.workspaceId, input.title, input.cwd, input.model, now, now),
  ];
  // スレッドのセッションは、そのスレッドの「いま続けているセッション」にする（4.2）
  if (input.threadId && (input.role === "coo" || input.role === "leader")) {
    stmts.push(db.prepare("UPDATE threads SET current_session_id = ?, updated_at = ? WHERE id = ?").bind(input.id, now, input.threadId));
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    mapConstraintError(err);
  }
  const row = (await getAgentSession(db, input.id))!;
  await publish(c.env, await sessionEvents(c.env, row));
  return c.json(checked(c.env, SessionOutput, { session: toAgentSession(row) }), 201);
});

runnerSessionRoutes.patch("/sessions/:id", async (c) => {
  const input = await readJson(c, SessionPatch);
  const db = c.env.DB;
  const row = await getAgentSession(db, c.req.param("id"));
  if (!row) throw notFound("session not found");
  const runnerId = c.get("runner").id;
  const now = Date.now();
  if (row.instruction_id) await requireWritable(db, row.instruction_id, runnerId, now).catch(async (err) => {
    // 取消された指示のセッションの終わり（canceled・failed・done）は受け付ける
    const st = await db.prepare("SELECT status FROM instructions WHERE id = ?").bind(row.instruction_id).first<{ status: string }>();
    if (st?.status === "canceled" && (input.status === "canceled" || input.status === "failed" || input.status === "done" || input.ended)) return;
    throw err;
  });
  const sets = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.status !== undefined) sets.push("status = ?"), args.push(input.status);
  if (input.pauseReason !== undefined) sets.push("pause_reason = ?"), args.push(input.pauseReason);
  if (input.activity !== undefined) sets.push("activity = ?", "activity_at = ?"), args.push(input.activity, now);
  if (input.turnsDelta) sets.push("turns = turns + ?"), args.push(input.turnsDelta);
  if (input.costUsdDelta) sets.push("cost_usd_est = cost_usd_est + ?"), args.push(input.costUsdDelta);
  if (input.tokensInDelta) sets.push("tokens_in = tokens_in + ?"), args.push(input.tokensInDelta);
  if (input.tokensOutDelta) sets.push("tokens_out = tokens_out + ?"), args.push(input.tokensOutDelta);
  if (input.claudeVersion !== undefined) sets.push("claude_version = ?"), args.push(input.claudeVersion);
  if (input.error !== undefined) sets.push("error = ?"), args.push(input.error);
  if (input.started) sets.push("started_at = COALESCE(started_at, ?)"), args.push(now);
  if (input.ended) sets.push("ended_at = ?"), args.push(now);
  const stmts = [db.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`).bind(...args, row.id)];
  // メンバーのセッションの推定額は指示の合計にも足す（スレッドのターンの分はランナーが指示の PATCH で足す）
  if (input.costUsdDelta && row.instruction_id && row.role === "member") {
    stmts.push(db.prepare("UPDATE instructions SET cost_usd_est = cost_usd_est + ? WHERE id = ?").bind(input.costUsdDelta, row.instruction_id));
  }
  await db.batch(stmts);
  const updated = (await getAgentSession(db, row.id))!;
  await publish(c.env, await sessionEvents(c.env, updated));
  return c.json(checked(c.env, SessionOutput, { session: toAgentSession(updated) }));
});

// ───────────── トランスクリプト（8.3・8.4） ─────────────

/** そのセッションの書き込みが許されるか（他のランナーが握っている指示のメンバーには書かない。D-36） */
const TRANSCRIPT_GUARD = `EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = ?2 AND (s.instruction_id IS NULL OR s.role <> 'member' OR EXISTS (
  SELECT 1 FROM instructions i WHERE i.id = s.instruction_id AND (i.lease_runner_id IS NULL OR i.lease_runner_id = ?16 OR i.lease_expires_at < ?15))))`;

runnerSessionRoutes.post("/transcript", async (c) => {
  const raw = await c.req.text();
  if (raw.length > LIMITS.transcriptPostBytes) throw invalid("transcript batch too large", { maxBytes: LIMITS.transcriptPostBytes });
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    throw invalid("invalid json");
  }
  const parsed = AppendTranscriptInput.safeParse(parsedBody);
  if (!parsed.success) throw invalid("invalid input", parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
  const { items } = parsed.data;
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const now = Date.now();

  // セッションごとの件数（上限で body を空に）と指示ごとの件数（上限で text・output・result・approval だけ）
  const sessionIds = [...new Set(items.map((i) => i.sessionId))];
  const sessions = new Map<string, AgentSessionRow>();
  for (const id of sessionIds) {
    const s = await getAgentSession(db, id);
    if (!s) throw invalid("session not found", { sessionId: id });
    if (s.instruction_id && s.role === "member") {
      const inst = await db.prepare("SELECT lease_runner_id, lease_expires_at FROM instructions WHERE id = ?").bind(s.instruction_id).first<{ lease_runner_id: string | null; lease_expires_at: number | null }>();
      if (inst?.lease_runner_id && inst.lease_runner_id !== runnerId && (inst.lease_expires_at ?? 0) >= now) throw conflict("lease not held");
    }
    sessions.set(id, s);
  }
  const sessionCounts = new Map<string, number>();
  const instructionCounts = new Map<string, number>();
  for (const id of sessionIds) {
    sessionCounts.set(id, (await db.prepare("SELECT count(*) AS n FROM transcript_items WHERE session_id = ?").bind(id).first<{ n: number }>())?.n ?? 0);
  }
  for (const iid of new Set(items.map((i) => i.instructionId).filter((x): x is string => !!x))) {
    instructionCounts.set(iid, (await db.prepare("SELECT count(*) AS n FROM transcript_items WHERE instruction_id = ?").bind(iid).first<{ n: number }>())?.n ?? 0);
  }
  const keep: typeof items = [];
  for (const it of items) {
    const sc = sessionCounts.get(it.sessionId) ?? 0;
    sessionCounts.set(it.sessionId, sc + 1);
    let item = it;
    if (sc >= LIMITS.itemsPerSession && (it.kind === "tool_result" || it.kind === "thinking")) item = { ...it, body: {}, truncated: true };
    if (it.instructionId) {
      const ic = instructionCounts.get(it.instructionId) ?? 0;
      instructionCounts.set(it.instructionId, ic + 1);
      if (ic >= LIMITS.itemsPerInstruction && !["text", "output", "result", "approval"].includes(it.kind)) continue;
    }
    keep.push(item);
  }

  let results: D1Result[] = [];
  if (keep.length > 0) {
    try {
      // seq の重複は無視する（送り直しても二重にならない）
      results = await db.batch(
        keep.map((it) =>
          db
            .prepare(
              `INSERT INTO transcript_items (id, session_id, thread_id, instruction_id, seq, kind, author, tool_name, tool_use_id, parent_tool_use_id,
                                             summary, body, truncated, is_error, created_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?17 WHERE ${TRANSCRIPT_GUARD}
               ON CONFLICT DO NOTHING`,
            )
            .bind(
              it.id,
              it.sessionId,
              it.threadId,
              it.instructionId,
              it.seq,
              it.kind,
              it.author,
              it.toolName,
              it.toolUseId,
              it.parentToolUseId,
              it.summary,
              JSON.stringify(it.body),
              it.truncated ? 1 : 0,
              it.isError ? 1 : 0,
              now,
              runnerId,
              it.createdAt,
            ),
        ),
      );
    } catch (err) {
      mapConstraintError(err);
    }
  }
  const insertedIds = keep.filter((_, n) => results[n]?.meta.changes === 1).map((it) => it.id);
  const lastSeqBySession: Record<string, number> = {};
  const updates: D1PreparedStatement[] = [];
  for (const id of sessionIds) {
    updates.push(
      db.prepare("UPDATE agent_sessions SET last_seq = max(last_seq, COALESCE((SELECT max(seq) FROM transcript_items WHERE session_id = ?1), 0)) WHERE id = ?1").bind(id),
      db.prepare("SELECT last_seq FROM agent_sessions WHERE id = ?").bind(id),
    );
  }
  const upd = await db.batch(updates);
  sessionIds.forEach((id, n) => {
    lastSeqBySession[id] = ((upd[n * 2 + 1]?.results?.[0] as { last_seq: number } | undefined)?.last_seq ?? 0) as number;
  });
  if (insertedIds.length > 0) {
    const { results: inserted } = await db
      .prepare(`SELECT * FROM transcript_items WHERE id IN (${insertedIds.map(() => "?").join(",")}) ORDER BY session_id, seq`)
      .bind(...insertedIds)
      .all<TranscriptRow>();
    const forBroadcast: TranscriptItem[] = inserted.map((r) => {
      const item = toTranscriptItem(r);
      const clipped = clipForBroadcast(item.body);
      return { ...item, body: clipped.body, truncated: item.truncated || clipped.truncated };
    });
    await publish(c.env, [{ t: "transcript.appended", items: forBroadcast }]);
  }
  return c.json(checked(c.env, AppendTranscriptOutput, { accepted: insertedIds.length, lastSeqBySession }));
});

// ───────────── 追加の依頼（5.6） ─────────────

runnerSessionRoutes.get("/sessions/:id/inputs", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM session_inputs WHERE session_id = ? AND status = 'pending' ORDER BY created_at")
    .bind(c.req.param("id"))
    .all<SessionInputRow>();
  return c.json(checked(c.env, PendingInputsOutput, { items: results.map(toSessionInput) }));
});

runnerSessionRoutes.post("/inputs/:id/delivered", async (c) => {
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM session_inputs WHERE id = ?").bind(c.req.param("id")).first<SessionInputRow>();
  if (!row) throw notFound("input not found");
  if (row.status === "pending") {
    await db.prepare("UPDATE session_inputs SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), row.id).run();
  }
  const updated = (await db.prepare("SELECT * FROM session_inputs WHERE id = ?").bind(row.id).first<SessionInputRow>())!;
  const view = toSessionInput(updated);
  await publish(c.env, [{ t: "session_input.upserted", input: view }]);
  return c.json(checked(c.env, SessionInputSchema, view));
});

// ───────────── 作業場所（7.3〜7.5） ─────────────

runnerSessionRoutes.get("/workspaces", async (c) => {
  const q = ListWorkspacesQuery.safeParse({ status: c.req.query("status") || undefined, instructionId: c.req.query("instructionId") || undefined });
  if (!q.success) throw invalid("invalid query");
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.data.status) {
    const list = q.data.status.split(",").map((s) => s.trim()).filter(Boolean);
    where.push(`status IN (${list.map(() => "?").join(",")})`);
    args.push(...list);
  }
  if (q.data.instructionId) where.push("instruction_id = ?"), args.push(q.data.instructionId);
  const { results } = await c.env.DB.prepare(`SELECT * FROM workspaces ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`)
    .bind(...args)
    .all<WorkspaceRow>();
  return c.json(checked(c.env, ListWorkspacesOutput, { items: results.map(toWorkspace) }));
});

runnerSessionRoutes.post("/workspaces", async (c) => {
  const input = await readJson(c, CreateWorkspaceInput);
  const db = c.env.DB;
  const existing = await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(input.id).first<WorkspaceRow>();
  if (existing) return c.json(checked(c.env, WorkspaceSchema, toWorkspace(existing)), 200);
  const now = Date.now();
  await requireWritable(db, input.instructionId, c.get("runner").id, now);
  try {
    await db
      .prepare(
        `INSERT INTO workspaces (id, instruction_id, project_id, purpose, task_id, parent_id, kind, repo_path, worktree_path, branch, base_ref, base_sha, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(input.id, input.instructionId, input.projectId, input.purpose, input.taskId, input.parentId, input.kind, input.repoPath, input.worktreePath, input.branch, input.baseRef, input.baseSha, now, now)
      .run();
  } catch (err) {
    mapConstraintError(err);
  }
  const row = (await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(input.id).first<WorkspaceRow>())!;
  await publish(c.env, [{ t: "workspace.upserted", workspace: toWorkspace(row) }]);
  return c.json(checked(c.env, WorkspaceSchema, toWorkspace(row)), 201);
});

runnerSessionRoutes.patch("/workspaces/:id", async (c) => {
  const input = await readJson(c, WorkspacePatch);
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(c.req.param("id")).first<WorkspaceRow>();
  if (!row) throw notFound("workspace not found");
  const now = Date.now();
  await requireWritable(db, row.instruction_id, c.get("runner").id, now).catch(async (err) => {
    // 取消・失敗・アーカイブされた指示の片付け（worktree を消した記録）は受け付ける
    const st = await db.prepare("SELECT status FROM instructions WHERE id = ?").bind(row.instruction_id).first<{ status: string }>();
    if (st && ["canceled", "failed", "archived"].includes(st.status)) return;
    throw err;
  });
  const sets = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.status !== undefined) sets.push("status = ?"), args.push(input.status);
  if (input.headSha !== undefined) sets.push("head_sha = ?"), args.push(input.headSha);
  if (input.diffStat !== undefined) sets.push("diff_stat = ?"), args.push(JSON.stringify(input.diffStat));
  if (input.diffPatch !== undefined) sets.push("diff_patch = ?"), args.push(input.diffPatch);
  if (input.diffTruncated !== undefined) sets.push("diff_truncated = ?"), args.push(input.diffTruncated ? 1 : 0);
  if (input.error !== undefined) sets.push("error = ?"), args.push(input.error);
  if (input.finalized) sets.push("finalized_at = ?"), args.push(now);
  try {
    await db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).bind(...args, row.id).run();
  } catch (err) {
    mapConstraintError(err);
  }
  const updated = toWorkspace((await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(row.id).first<WorkspaceRow>())!);
  await publish(c.env, [{ t: "workspace.upserted", workspace: updated }]);
  return c.json(checked(c.env, WorkspaceSchema, updated));
});

// ───────────── リポジトリの候補（3.2） ─────────────

const REPO_STALE_MS = 24 * 60 * 60 * 1000;

runnerSessionRoutes.put("/repos", async (c) => {
  const input = await readJson(c, PutReposInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const now = Date.now();
  for (const it of input.items) {
    if (!it.path.startsWith("/") || it.path.includes("/../") || it.path.endsWith("/..")) throw invalid("repository path must be absolute", { path: it.path });
  }
  const stmts = input.items.map((it) =>
    db
      .prepare(
        `INSERT INTO runner_repos (path, runner_id, name, default_branch, head_sha, last_commit_at, dirty, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET runner_id = excluded.runner_id, name = excluded.name, default_branch = excluded.default_branch,
           head_sha = excluded.head_sha, last_commit_at = excluded.last_commit_at, dirty = excluded.dirty, seen_at = excluded.seen_at`,
      )
      .bind(it.path, runnerId, it.name, it.defaultBranch, it.headSha, it.lastCommitAt, it.dirty ? 1 : 0, now),
  );
  // 24 時間見えなければ候補から消す
  stmts.push(db.prepare("DELETE FROM runner_repos WHERE runner_id = ? AND seen_at < ?").bind(runnerId, now - REPO_STALE_MS));
  await db.batch(stmts);
  return c.body(null, 204);
});
