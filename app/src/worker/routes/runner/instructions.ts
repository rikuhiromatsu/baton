// ランナーの指示まわりの書き込み: 指示・タスク・承認・判断・成果物・確定（DESIGN-v2 4.4・5.5・7.5・7.6・12.3）
import { Hono } from "hono";
import {
  ArtifactSchema,
  COO_THREAD_ID,
  CreateApprovalInput,
  CreateArtifactInput,
  CreateDecisionInput,
  CreateTasksInput,
  CreateTasksOutput,
  DecisionSchema,
  FinalizedInput,
  InstructionReleaseInput,
  InstructionSummarySchema,
  LIMITS,
  RunnerCreateInstructionInput,
  RunnerInstructionPatch,
  TaskPatch,
  TaskSchema,
  UI_TEXT_V2,
  canReopen,
  canSystemTransition,
  type InstructionStatus,
  type ServerEvent,
} from "@baton/shared";
import { z } from "zod";
import { ARTIFACT_SELECT } from "../../db/detail.ts";
import { getSummary, requireLease, requireWritable, transitionAfterUpdate, writableSql } from "../../db/instructions.ts";
import { leaderThreadIdOf } from "../../db/projects.ts";
import { toArtifact, toArtifactMeta, toDecision, toTask, type ArtifactRow, type DecisionRow, type TaskRow } from "../../db/rows.ts";
import { getThread, messageInsertStatements, noticeStatements, primaryUserId } from "../../db/threads.ts";
import { afterMessages, decisionPushCandidate, instructionEvents, notifyRunners, publish, queuePush } from "../../hub/broadcast.ts";
import { newId } from "../../lib/crypto.ts";
import { ApiError, conflict, invalid, notFound } from "../../lib/errors.ts";
import { checked, readJson } from "../../lib/validate.ts";
import type { AppEnv } from "../../types.ts";

export const runnerInstructionRoutes = new Hono<AppEnv>();

const DecisionOutput = z.object({ decision: DecisionSchema });

/** D1 の制約違反（外部キー・CHECK・UNIQUE）を 400 / 409 にする */
export function mapConstraintError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/FOREIGN KEY/i.test(msg)) throw invalid("referenced row not found");
  if (/UNIQUE/i.test(msg)) throw conflict("duplicate");
  if (/CHECK/i.test(msg)) throw invalid("constraint failed");
  throw err;
}

// ───────────── 指示 ─────────────

/** 指示の作成（冪等。COO の delegate、リーダーの plan の instructionId: null。D-73） */
runnerInstructionRoutes.post("/instructions", async (c) => {
  const input = await readJson(c, RunnerCreateInstructionInput);
  const db = c.env.DB;
  const existing = await getSummary(db, input.id);
  if (existing) return c.json(checked(c.env, InstructionSummarySchema, existing), 200);
  const project = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(input.projectId).first();
  if (!project) throw invalid("project not found");
  const thread = await getThread(db, input.originThreadId);
  if (!thread) throw invalid("origin thread not found");
  // created_by は CEO（個人用なので最初の利用者）
  const userId = await primaryUserId(db);
  if (!userId) throw conflict("no user yet");
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO instructions (id, client_id, created_by, body, title, status, status_changed_at, project_id, origin_thread_id, origin_message_id,
                                     revision, phase, created_at, updated_at)
           VALUES (?1, ?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?8, 1, ?9, ?5, ?5) ON CONFLICT DO NOTHING`,
        )
        .bind(input.id, userId, input.body, input.title, now, input.projectId, input.originThreadId, input.originMessageId, input.phase),
      transitionAfterUpdate(db, { id: newId(), instructionId: input.id, from: "queued", to: "queued", action: "create", actor: "runner", now }),
    ]);
  } catch (err) {
    mapConstraintError(err);
  }
  await publish(c.env, await instructionEvents(c.env, [input.id]));
  return c.json(checked(c.env, InstructionSummarySchema, (await getSummary(db, input.id))!), 201);
});

const LEASE_RELEASING: readonly InstructionStatus[] = ["queued", "needs_decision", "review", "failed"];

runnerInstructionRoutes.patch("/instructions/:id", async (c) => {
  const input = await readJson(c, RunnerInstructionPatch);
  const db = c.env.DB;
  const id = c.req.param("id");
  const runnerId = c.get("runner").id;
  const now = Date.now();
  const row = await requireWritable(db, id, runnerId, now);
  // COO の present・relay の版の検査（4.6・D-79）
  if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) {
    throw new ApiError("stale_revision", "instruction revision changed", { revision: row.revision });
  }
  let to: InstructionStatus | null = null;
  let action = "report";
  if (input.reopen) {
    if (!canReopen(row.status)) throw conflict("cannot reopen", { status: row.status });
    to = "running";
    action = "reopen";
  } else if (input.status && input.status !== row.status) {
    if (!canSystemTransition(row.status, input.status)) throw conflict("transition not allowed", { status: row.status, to: input.status });
    to = input.status;
  }
  const sets = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.title !== undefined) sets.push("title = ?"), args.push(input.title);
  if (input.phase !== undefined) sets.push("phase = ?"), args.push(input.phase);
  if (input.resultSummary !== undefined) sets.push("result_summary = ?"), args.push(input.resultSummary);
  if (input.error !== undefined) sets.push("error = ?"), args.push(input.error);
  if (input.revisionBump) sets.push("revision = revision + 1");
  if (input.costUsdDelta) sets.push("cost_usd_est = cost_usd_est + ?"), args.push(input.costUsdDelta);
  if (to) {
    sets.push("status = ?", "status_changed_at = ?");
    args.push(to, now);
    if (LEASE_RELEASING.includes(to)) sets.push("lease_runner_id = NULL", "lease_expires_at = NULL");
    if (to === "failed") sets.push("completed_at = ?"), args.push(now);
    if (to === "review" && input.error === undefined) sets.push("error = NULL");
    if (action === "reopen") sets.push("completed_at = NULL", "finalized_at = NULL");
  }
  // 検査と書き込みの間に状態・版・lease が変わっていたら当たらない（409）
  const where = [`id = ?`, `status = ?`, `revision = ?`, writableSql("instructions", "?", "?")];
  const stmts = [db.prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).bind(...args, id, row.status, row.revision, runnerId, now)];
  if (to) stmts.push(transitionAfterUpdate(db, { id: newId(), instructionId: id, from: row.status, to, action, actor: "runner", now }));
  const results = await db.batch(stmts);
  if (results[0]?.meta.changes !== 1) throw conflict("instruction changed");
  await publish(c.env, await instructionEvents(c.env, [id]));
  if (to === "queued") await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.json(checked(c.env, InstructionSummarySchema, (await getSummary(db, id))!));
});

/** lease を外す（枠待ち・停止。状態はそのまま。9.2） */
runnerInstructionRoutes.post("/instructions/:id/release", async (c) => {
  const input = await readJson(c, InstructionReleaseInput);
  const db = c.env.DB;
  const id = c.req.param("id");
  const runnerId = c.get("runner").id;
  await requireLease(db, id, runnerId);
  const now = Date.now();
  const sets = ["lease_runner_id = NULL", "lease_expires_at = NULL", "not_before = ?", "updated_at = ?"];
  const args: unknown[] = [input.notBefore, now];
  if (input.error !== undefined) sets.push("error = ?"), args.push(input.error);
  const res = await db.prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE id = ? AND lease_runner_id = ?`).bind(...args, id, runnerId).run();
  if (res.meta.changes !== 1) throw conflict("lease not held");
  await publish(c.env, await instructionEvents(c.env, [id]));
  if (input.notBefore === null || input.notBefore <= now) await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.body(null, 204);
});

/** 確定（承認から 20 秒後の取り込み・片付け。7.5・D-66） */
runnerInstructionRoutes.post("/instructions/:id/finalized", async (c) => {
  const input = await readJson(c, FinalizedInput);
  const db = c.env.DB;
  const id = c.req.param("id");
  const runnerId = c.get("runner").id;
  const row = await requireLease(db, id, runnerId);
  if (row.status !== "done") throw conflict("instruction is not done", { status: row.status });
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE instructions SET finalized_at = ?, lease_runner_id = NULL, lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ? AND lease_runner_id = ? AND status = 'done'")
      .bind(now, input.error ?? null, now, id, runnerId),
  ];
  const messageIds: string[] = [];
  if (input.outcome === "conflict" || input.outcome === "failed") {
    // Baton 専用で main に取り込めなかった（ブランチは残した）
    const label = row.title ?? row.body.slice(0, 40);
    const body = `${UI_TEXT_V2.transcript.conflict}: 「${label}」${input.branch ? ` ${UI_TEXT_V2.diff.branch} ${input.branch}` : ""}`;
    const n = noticeStatements(db, COO_THREAD_ID, body, { notice: "finalize_conflict", branch: input.branch }, id, now);
    stmts.push(...n.stmts);
    messageIds.push(n.id);
  }
  const results = await db.batch(stmts);
  if (results[0]?.meta.changes !== 1) throw conflict("lease not held");
  if (messageIds.length > 0) await afterMessages(c.env, messageIds, { push: false });
  await publish(c.env, await instructionEvents(c.env, [id]));
  return c.json(checked(c.env, InstructionSummarySchema, (await getSummary(db, id))!));
});

// ───────────── タスク ─────────────

runnerInstructionRoutes.post("/tasks", async (c) => {
  const { tasks } = await readJson(c, CreateTasksInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const now = Date.now();
  const instructionIds = [...new Set(tasks.map((t) => t.instructionId))];
  const projectOf = new Map<string, string | null>();
  for (const iid of instructionIds) projectOf.set(iid, (await requireWritable(db, iid, runnerId, now)).project_id);
  const withIds = tasks.map((t) => ({ ...t, id: t.id ?? newId() }));
  try {
    // 同じ id・同じ plan_key は既存のものを使う（再送の冪等性）。lease は INSERT 自体の条件でも見る（D-36）
    await db.batch(
      withIds.map((t) =>
        db
          .prepare(
            `INSERT INTO tasks (id, instruction_id, parent_task_id, project_id, assignee_agent_id, kind, plan_key, depends_on, title, spec, paths,
                                status, round, seq, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?14, ?14
             WHERE EXISTS (SELECT 1 FROM instructions i WHERE i.id = ?2 AND ${writableSql("i", "?15", "?14")})
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            t.id,
            t.instructionId,
            t.parentTaskId,
            projectOf.get(t.instructionId) ?? null,
            t.assigneeAgentId,
            t.kind,
            t.planKey,
            JSON.stringify(t.dependsOn),
            t.title,
            t.spec,
            JSON.stringify(t.paths),
            t.round,
            t.seq,
            now,
            runnerId,
          ),
      ),
    );
  } catch (err) {
    mapConstraintError(err);
  }
  // 書き込みの間に取消・別ランナーへの再 claim があれば 409
  for (const iid of instructionIds) await requireWritable(db, iid, runnerId);
  const rows = await db.batch(
    withIds.map((t) =>
      db
        .prepare(
          "SELECT * FROM tasks WHERE id = ? OR (instruction_id = ? AND round = ? AND plan_key IS NOT NULL AND plan_key = ?) ORDER BY id = ? DESC LIMIT 1",
        )
        .bind(t.id, t.instructionId, t.round, t.planKey, t.id),
    ),
  );
  const items = rows.map((r) => (r.results as TaskRow[])[0]).filter((r): r is TaskRow => !!r).map(toTask);
  if (items.length !== withIds.length) throw conflict("lease not held");
  for (const [n, task] of items.entries()) {
    if (task.instructionId !== withIds[n]!.instructionId) throw conflict("task id belongs to another instruction");
  }
  const events: ServerEvent[] = items.map((task) => ({ t: "task.upserted", task }));
  events.push(...(await instructionEvents(c.env, instructionIds)));
  await publish(c.env, events);
  if (items.some((t) => t.status === "pending")) await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.json(checked(c.env, CreateTasksOutput, { items }), 201);
});

runnerInstructionRoutes.patch("/tasks/:id", async (c) => {
  const input = await readJson(c, TaskPatch);
  const db = c.env.DB;
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(c.req.param("id")).first<TaskRow>();
  if (!task) throw notFound("task not found");
  const runnerId = c.get("runner").id;
  const now = Date.now();
  await requireWritable(db, task.instruction_id, runnerId, now);
  const sets = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.status !== undefined) {
    sets.push("status = ?");
    args.push(input.status);
    if (input.status === "running") sets.push("started_at = COALESCE(started_at, ?)", "attempt = attempt + 1"), args.push(now);
    if (input.status === "pending") sets.push("finished_at = NULL");
    if (input.status === "done" || input.status === "failed" || input.status === "canceled") sets.push("finished_at = ?"), args.push(now);
  }
  if (input.resultSummary !== undefined) sets.push("result_summary = ?"), args.push(input.resultSummary);
  if (input.assigneeAgentId !== undefined) sets.push("assignee_agent_id = ?"), args.push(input.assigneeAgentId);
  let changes = 0;
  try {
    const res = await db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND EXISTS (SELECT 1 FROM instructions i WHERE i.id = tasks.instruction_id AND ${writableSql("i", "?", "?")})`)
      .bind(...args, task.id, runnerId, now)
      .run();
    changes = res.meta.changes;
  } catch (err) {
    mapConstraintError(err);
  }
  if (changes !== 1) throw conflict("lease not held");
  const updated = toTask((await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first<TaskRow>())!);
  await publish(c.env, [{ t: "task.upserted", task: updated }, ...(await instructionEvents(c.env, [task.instruction_id]))]);
  return c.json(checked(c.env, TaskSchema, updated));
});

// ───────────── 承認・判断（7.6・D-45・D-53） ─────────────

/** 承認の依頼。指示は止めない（承認待ちのセッションだけ止まる）。通知はすぐ */
runnerInstructionRoutes.post("/approvals", async (c) => {
  const input = await readJson(c, CreateApprovalInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const now = Date.now();
  const existing = await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(input.id).first<DecisionRow>();
  if (existing) return c.json(checked(c.env, DecisionSchema, toDecision(existing)), 200);
  const inst = await requireWritable(db, input.instructionId, runnerId, now);
  const session = await db.prepare("SELECT id, instruction_id FROM agent_sessions WHERE id = ?").bind(input.sessionId).first<{ id: string; instruction_id: string | null }>();
  if (!session) throw invalid("session not found");
  const count = await db.prepare("SELECT count(*) AS n FROM decisions WHERE instruction_id = ? AND kind = 'approval'").bind(input.instructionId).first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.approvalsPerInstruction) throw conflict("approval limit reached", { limit: LIMITS.approvalsPerInstruction });
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO decisions (id, instruction_id, task_id, asked_by_agent_id, question, options, status, created_at, kind, session_id, tool_name, tool_input, tool_use_id)
         SELECT ?1, ?2, ?3, ?4, ?5, '[]', 'open', ?6, 'approval', ?7, ?8, ?9, ?10
         WHERE EXISTS (SELECT 1 FROM instructions i WHERE i.id = ?2 AND ${writableSql("i", "?11", "?6")})`,
      )
      .bind(input.id, input.instructionId, input.taskId, input.askedByAgentId, input.question, now, input.sessionId, input.toolName, JSON.stringify(input.toolInput), input.toolUseId, runnerId),
    db.prepare("UPDATE agent_sessions SET status = 'awaiting_approval', pause_reason = NULL, updated_at = ? WHERE id = ? AND changes() = 1").bind(now, input.sessionId),
  ];
  // リーダーのスレッドに承認カードへの入口（4.3。通知は承認として別に送る）
  const leaderThread = inst.project_id ? await getThread(db, leaderThreadIdOf(inst.project_id)) : null;
  let messageId: string | null = null;
  if (leaderThread) {
    const m = messageInsertStatements(
      db,
      {
        threadId: leaderThread.id,
        authorKind: "system",
        kind: "approval",
        body: input.question,
        instructionId: input.instructionId,
        sessionId: input.sessionId,
        ref: { decisionId: input.id },
        notify: false,
      },
      now,
    );
    stmts.push(...m.stmts);
    messageId = m.id;
  }
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    mapConstraintError(err);
  }
  if (results[0]?.meta.changes !== 1) throw conflict("lease not held");
  const decision = toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(input.id).first<DecisionRow>())!);
  await publish(c.env, [{ t: "decision.upserted", decision }, ...(await instructionEvents(c.env, [input.instructionId]))]);
  if (messageId) await afterMessages(c.env, [messageId], { push: false });
  await queuePush(c.env, decisionPushCandidate(decision));
  return c.json(checked(c.env, DecisionSchema, decision), 201);
});

/**
 * 判断（中断・承認の時間切れからの再開 interrupted、v1 の question）。セッションを paused にし、
 * 他に動いているメンバーがいなければ指示を needs_decision にして lease を外す（4.4）
 */
runnerInstructionRoutes.post("/decisions", async (c) => {
  const input = await readJson(c, CreateDecisionInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const now = Date.now();
  const id = input.id ?? newId();
  const existing = await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(id).first<DecisionRow>();
  if (existing) return c.json(checked(c.env, DecisionSchema, toDecision(existing)), 200);
  const inst = await requireWritable(db, input.instructionId, runnerId, now);
  const from = input.fromApprovalId
    ? await db.prepare("SELECT * FROM decisions WHERE id = ? AND instruction_id = ? AND kind = 'approval'").bind(input.fromApprovalId, input.instructionId).first<DecisionRow>()
    : null;
  if (input.fromApprovalId && !from) throw invalid("approval not found");
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO decisions (id, instruction_id, task_id, asked_by_agent_id, question, options, status, created_at, kind, session_id, tool_name, tool_input, tool_use_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, ?11, ?12
         WHERE EXISTS (SELECT 1 FROM instructions i WHERE i.id = ?2 AND ${writableSql("i", "?13", "?7")})`,
      )
      .bind(
        id,
        input.instructionId,
        input.taskId,
        input.askedByAgentId,
        input.question,
        JSON.stringify(input.options),
        now,
        input.kind,
        input.sessionId,
        from?.tool_name ?? null,
        from?.tool_input ?? null,
        from?.tool_use_id ?? null,
        runnerId,
      ),
  ];
  if (from) stmts.push(db.prepare("UPDATE decisions SET status = 'canceled' WHERE id = ? AND status = 'open'").bind(from.id));
  if (input.sessionId) {
    stmts.push(
      db
        .prepare("UPDATE agent_sessions SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?")
        .bind(input.kind === "interrupted" ? (from ? "approval" : "interrupted") : "question", now, input.sessionId),
    );
  }
  if (inst.status === "running") {
    stmts.push(
      db
        .prepare(
          `UPDATE instructions SET status = 'needs_decision', status_changed_at = ?1, updated_at = ?1, lease_runner_id = NULL, lease_expires_at = NULL
            WHERE id = ?2 AND status = 'running'
              AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.instruction_id = ?2 AND s.role = 'member'
                                AND s.status IN ('running','awaiting_approval') AND s.id <> COALESCE(?3, ''))`,
        )
        .bind(now, input.instructionId, input.sessionId),
      transitionAfterUpdate(db, { id: newId(), instructionId: input.instructionId, from: "running", to: "needs_decision", action: input.kind, actor: "runner", now }),
    );
  }
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    mapConstraintError(err);
  }
  if (results[0]?.meta.changes !== 1) throw conflict("lease not held");
  const events: ServerEvent[] = [];
  const decision = toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(id).first<DecisionRow>())!);
  events.push({ t: "decision.upserted", decision });
  if (from) events.push({ t: "decision.upserted", decision: toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(from.id).first<DecisionRow>())!) });
  events.push(...(await instructionEvents(c.env, [input.instructionId])));
  await publish(c.env, events);
  await queuePush(c.env, decisionPushCandidate(decision));
  return c.json(checked(c.env, DecisionSchema, decision), 201);
});

/**
 * 判断・承認を読む（decision.answered の合図は ID だけなので、verdict・answer はここで取る。7.6）。
 * その指示を他のランナーが握っていれば 409（関わっているランナーだけが読む）
 */
runnerInstructionRoutes.get("/decisions/:id", async (c) => {
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(c.req.param("id")).first<DecisionRow>();
  if (!row) throw notFound("decision not found");
  const inst = await db.prepare("SELECT lease_runner_id, lease_expires_at FROM instructions WHERE id = ?").bind(row.instruction_id).first<{ lease_runner_id: string | null; lease_expires_at: number | null }>();
  const runnerId = c.get("runner").id;
  if (inst?.lease_runner_id && inst.lease_runner_id !== runnerId && (inst.lease_expires_at ?? 0) >= Date.now()) throw conflict("lease held by another runner");
  return c.json(checked(c.env, DecisionOutput, { decision: toDecision(row) }));
});

// ───────────── 成果物 ─────────────

runnerInstructionRoutes.post("/artifacts", async (c) => {
  const input = await readJson(c, CreateArtifactInput);
  const db = c.env.DB;
  const runnerId = c.get("runner").id;
  const now = Date.now();
  const inst = await requireWritable(db, input.instructionId, runnerId, now);
  let changes = 0;
  try {
    const res = await db
      .prepare(
        `INSERT INTO artifacts (id, instruction_id, task_id, project_id, rel_path, title, mime, size_bytes, sha256, preview_text, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
         WHERE EXISTS (SELECT 1 FROM instructions i WHERE i.id = ?2 AND ${writableSql("i", "?12", "?11")})
         ON CONFLICT(instruction_id, rel_path, sha256) DO NOTHING`,
      )
      .bind(newId(), input.instructionId, input.taskId, inst.project_id, input.relPath, input.title, input.mime, input.sizeBytes, input.sha256, input.previewText, now, runnerId)
      .run();
    changes = res.meta.changes;
  } catch (err) {
    mapConstraintError(err);
  }
  await requireWritable(db, input.instructionId, runnerId);
  // 同じ path・hash は既存を返す
  const row = await db
    .prepare(`${ARTIFACT_SELECT} WHERE a.instruction_id = ? AND a.rel_path = ? AND a.sha256 = ?`)
    .bind(input.instructionId, input.relPath, input.sha256)
    .first<ArtifactRow>();
  if (!row) throw conflict("lease not held");
  if (changes === 1) await publish(c.env, [{ t: "artifact.created", artifact: toArtifactMeta(row) }]);
  return c.json(checked(c.env, ArtifactSchema, toArtifact(row)), changes === 1 ? 201 : 200);
});

