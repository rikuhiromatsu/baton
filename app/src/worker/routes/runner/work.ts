// ランナーの書き込み: プロジェクト・エージェント・タスク・イベント・成果物・判断（設計書 4.3・5.2・5.7）
import { Hono } from "hono";
import {
  AppendEventsInput,
  AppendEventsOutput,
  ArtifactSchema,
  CreateAgentsInput,
  CreateAgentsOutput,
  CreateArtifactInput,
  CreateDecisionInput,
  CreateProjectInput,
  CreateTasksInput,
  CreateTasksOutput,
  DecisionSchema,
  LIMITS,
  ProjectWithTeamSchema,
  TaskPatch,
  TaskSchema,
  type ServerEvent,
} from "@baton/shared";
import { ARTIFACT_SELECT } from "../../db/details.ts";
import { getSummary, transitionAfterUpdate } from "../../db/instructions.ts";
import { getProject, pickFreeSlug } from "../../db/projects.ts";
import {
  toAgent,
  toAgentEvent,
  toArtifact,
  toArtifactMeta,
  toDecision,
  toTask,
  type AgentEventRow,
  type AgentRow,
  type ArtifactRow,
  type DecisionRow,
  type TaskRow,
} from "../../db/rows.ts";
import { clipEventContent } from "../../hub/batonhub.ts";
import { publish } from "../../hub/broadcast.ts";
import { newId } from "../../lib/crypto.ts";
import { conflict, invalid, notFound } from "../../lib/errors.ts";
import { checked, readJson } from "../../lib/validate.ts";
import type { AppEnv } from "../../types.ts";
import { LEASE_WHERE, requireLease } from "./lease.ts";

export const runnerWorkRoutes = new Hono<AppEnv>();

/** D1 の制約違反（外部キー・CHECK・UNIQUE）を 400 / 409 にする */
function mapConstraintError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/FOREIGN KEY/i.test(msg)) throw invalid("referenced row not found");
  if (/UNIQUE/i.test(msg)) throw conflict("duplicate");
  if (/CHECK/i.test(msg)) throw invalid("constraint failed");
  throw err;
}

// ───────────── プロジェクト・エージェント ─────────────

runnerWorkRoutes.post("/projects", async (c) => {
  const input = await readJson(c, CreateProjectInput);
  const db = c.env.DB;
  await requireLease(db, input.instructionId, c.get("runner").id);
  const now = Date.now();
  // slug が衝突したら -2、-3 … を付ける。同時作成で UNIQUE に当たったら選び直す
  for (let tries = 0; tries < 3; tries++) {
    const slug = await pickFreeSlug(db, input.slug);
    const projectId = newId();
    const agentStmts = [input.leader, ...input.members].map((a, n) =>
      db
        .prepare("INSERT INTO agents (id, project_id, role, name, specialty, model, active, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?)")
        .bind(newId(), projectId, n === 0 ? "leader" : "member", a.name, a.specialty, now + n),
    );
    try {
      await db.batch([
        db
          .prepare("INSERT INTO projects (id, slug, name, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
          .bind(projectId, slug, input.name, input.summary, now, now),
        ...agentStmts,
      ]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err)) && /slug/i.test(String(err))) continue;
      mapConstraintError(err);
    }
    const project = (await getProject(db, projectId))!;
    return c.json(checked(c.env, ProjectWithTeamSchema, project), 201);
  }
  throw conflict("could not allocate slug");
});

runnerWorkRoutes.post("/projects/:id/agents", async (c) => {
  const input = await readJson(c, CreateAgentsInput);
  const db = c.env.DB;
  const projectId = c.req.param("id");
  await requireLease(db, input.instructionId, c.get("runner").id);
  const project = await db.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) throw notFound("project not found");
  const count = await db
    .prepare("SELECT count(*) AS n FROM agents WHERE project_id = ? AND role = 'member' AND active = 1")
    .bind(projectId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) + input.agents.length > 3) throw conflict("a team has at most 3 members", { current: count?.n ?? 0 });
  const now = Date.now();
  const ids = input.agents.map(() => newId());
  await db.batch([
    ...input.agents.map((a, n) =>
      db
        .prepare("INSERT INTO agents (id, project_id, role, name, specialty, model, active, created_at) VALUES (?, ?, 'member', ?, ?, NULL, 1, ?)")
        .bind(ids[n], projectId, a.name, a.specialty, now + n),
    ),
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now, projectId),
  ]);
  const { results } = await db
    .prepare(`SELECT * FROM agents WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`)
    .bind(...ids)
    .all<AgentRow>();
  return c.json(checked(c.env, CreateAgentsOutput, { items: results.map(toAgent) }), 201);
});

// ───────────── タスク ─────────────

runnerWorkRoutes.post("/tasks", async (c) => {
  const { tasks } = await readJson(c, CreateTasksInput);
  const db = c.env.DB;
  const runner = c.get("runner");
  const instructionIds = [...new Set(tasks.map((t) => t.instructionId))];
  const projectOf = new Map<string, string | null>();
  for (const iid of instructionIds) projectOf.set(iid, (await requireLease(db, iid, runner.id)).project_id);
  const now = Date.now();
  const withIds = tasks.map((t) => ({ ...t, id: t.id ?? newId() }));
  try {
    // 同じ id・同じ plan_key は既存のものを使う（再送の冪等性）
    await db.batch(
      withIds.map((t) =>
        db
          .prepare(
            `INSERT INTO tasks (id, instruction_id, parent_task_id, project_id, assignee_agent_id, kind, plan_key, depends_on, title, spec,
                                status, round, seq, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
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
            t.round,
            t.seq,
            now,
            now,
          ),
      ),
    );
  } catch (err) {
    mapConstraintError(err);
  }
  const rows = await db.batch(
    withIds.map((t) =>
      db
        .prepare(
          "SELECT * FROM tasks WHERE id = ? OR (instruction_id = ? AND round = ? AND plan_key IS NOT NULL AND plan_key = ?) ORDER BY id = ? DESC LIMIT 1",
        )
        .bind(t.id, t.instructionId, t.round, t.planKey, t.id),
    ),
  );
  const items = rows.map((r) => toTask((r.results as TaskRow[])[0]!));
  for (const [n, task] of items.entries()) {
    if (task.instructionId !== withIds[n]!.instructionId) throw conflict("task id belongs to another instruction");
  }
  const events: ServerEvent[] = items.map((task) => ({ t: "task.upserted", task }));
  for (const iid of instructionIds) events.push({ t: "instruction.upserted", instruction: (await getSummary(db, iid))! });
  await publish(c.env, events);
  return c.json(checked(c.env, CreateTasksOutput, { items }), 201);
});

runnerWorkRoutes.patch("/tasks/:id", async (c) => {
  const input = await readJson(c, TaskPatch);
  const db = c.env.DB;
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(c.req.param("id")).first<TaskRow>();
  if (!task) throw notFound("task not found");
  const runner = c.get("runner");
  await requireLease(db, task.instruction_id, runner.id);
  const now = Date.now();
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
  try {
    await db
      .prepare(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND EXISTS (SELECT 1 FROM instructions WHERE id = tasks.instruction_id AND ${LEASE_WHERE})`,
      )
      .bind(...args, task.id, runner.id)
      .run();
  } catch (err) {
    mapConstraintError(err);
  }
  const updated = toTask((await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first<TaskRow>())!);
  await publish(c.env, [
    { t: "task.upserted", task: updated },
    { t: "instruction.upserted", instruction: (await getSummary(db, task.instruction_id))! },
  ]);
  return c.json(checked(c.env, TaskSchema, updated));
});

// ───────────── イベント ─────────────

/** D1 に残す content（16KB を超えたら切る） */
function storedContent(content: unknown): string {
  const text = JSON.stringify(content ?? null);
  if (text.length <= LIMITS.eventContentMaxChars) return text;
  return JSON.stringify({ truncated: true, text: text.slice(0, LIMITS.eventContentMaxChars) });
}

runnerWorkRoutes.post("/events", async (c) => {
  const input = await readJson(c, AppendEventsInput);
  const db = c.env.DB;
  await requireLease(db, input.instructionId, c.get("runner").id);
  const now = Date.now();
  const rows = input.events.map((e) => ({ id: newId(), ...e }));
  let results: D1Result[];
  try {
    // seq の重複は無視する（送り直しても二重にならない）
    results = await db.batch(
      rows.map((e) =>
        db
          .prepare(
            `INSERT INTO agent_events (id, instruction_id, task_id, agent_id, seq, kind, content, model, tokens_in, tokens_out, duration_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(instruction_id, seq) DO NOTHING`,
          )
          .bind(
            e.id,
            input.instructionId,
            e.taskId,
            e.agentId,
            e.seq,
            e.kind,
            storedContent(e.content),
            e.model ?? null,
            e.tokensIn ?? null,
            e.tokensOut ?? null,
            e.durationMs ?? null,
            now,
          ),
      ),
    );
  } catch (err) {
    mapConstraintError(err);
  }
  const insertedIds = rows.filter((_, n) => results[n]?.meta.changes === 1).map((e) => e.id);
  const last = await db.prepare("SELECT max(seq) AS seq FROM agent_events WHERE instruction_id = ?").bind(input.instructionId).first<{ seq: number | null }>();
  if (insertedIds.length > 0) {
    const { results: inserted } = await db
      .prepare(`SELECT * FROM agent_events WHERE id IN (${insertedIds.map(() => "?").join(",")}) ORDER BY seq`)
      .bind(...insertedIds)
      .all<AgentEventRow>();
    await publish(
      c.env,
      inserted.map((r) => {
        const event = toAgentEvent(r);
        return { t: "agent_event.appended", event: { ...event, content: clipEventContent(event.content) } } as const;
      }),
    );
  }
  return c.json(checked(c.env, AppendEventsOutput, { lastSeq: last?.seq ?? -1 }));
});

// ───────────── 成果物 ─────────────

runnerWorkRoutes.post("/artifacts", async (c) => {
  const input = await readJson(c, CreateArtifactInput);
  const db = c.env.DB;
  const inst = await requireLease(db, input.instructionId, c.get("runner").id);
  const now = Date.now();
  let changes = 0;
  try {
    const res = await db
      .prepare(
        `INSERT INTO artifacts (id, instruction_id, task_id, project_id, rel_path, title, mime, size_bytes, sha256, preview_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(instruction_id, rel_path, sha256) DO NOTHING`,
      )
      .bind(
        newId(),
        input.instructionId,
        input.taskId,
        inst.project_id,
        input.relPath,
        input.title,
        input.mime,
        input.sizeBytes,
        input.sha256,
        input.previewText,
        now,
      )
      .run();
    changes = res.meta.changes;
  } catch (err) {
    mapConstraintError(err);
  }
  // 同じ path・hash は既存を返す
  const row = (await db
    .prepare(`${ARTIFACT_SELECT} WHERE a.instruction_id = ? AND a.rel_path = ? AND a.sha256 = ?`)
    .bind(input.instructionId, input.relPath, input.sha256)
    .first<ArtifactRow>())!;
  if (changes === 1) await publish(c.env, [{ t: "artifact.created", artifact: toArtifactMeta(row) }]);
  return c.json(checked(c.env, ArtifactSchema, toArtifact(row)), changes === 1 ? 201 : 200);
});

// ───────────── 判断 ─────────────

runnerWorkRoutes.post("/decisions", async (c) => {
  const input = await readJson(c, CreateDecisionInput);
  const db = c.env.DB;
  const runner = c.get("runner");
  await requireLease(db, input.instructionId, runner.id);
  const count = await db.prepare("SELECT count(*) AS n FROM decisions WHERE instruction_id = ?").bind(input.instructionId).first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.decisionsPerInstruction) {
    // 4 回目は作らない。ランナーは仮定を置いて続ける（設計書 5.7）
    throw invalid("decision limit reached", { limit: LIMITS.decisionsPerInstruction });
  }
  const now = Date.now();
  const id = newId();
  // 判断を作り、指示を needs_decision にして握りを外す（同じトランザクション）
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `UPDATE instructions SET status = 'needs_decision', status_changed_at = ?, updated_at = ?, lease_runner_id = NULL, lease_expires_at = NULL
           WHERE id = ? AND ${LEASE_WHERE}`,
        )
        .bind(now, now, input.instructionId, runner.id),
      transitionAfterUpdate(db, { id: newId(), instructionId: input.instructionId, from: "running", to: "needs_decision", action: "ask_ceo", actor: "runner", now }),
      db
        .prepare(
          `INSERT INTO decisions (id, instruction_id, task_id, asked_by_agent_id, question, options, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'open', ? WHERE EXISTS (SELECT 1 FROM instructions WHERE id = ? AND status = 'needs_decision' AND status_changed_at = ?)`,
        )
        .bind(id, input.instructionId, input.taskId, input.askedByAgentId, input.question, JSON.stringify(input.options), now, input.instructionId, now),
    ]);
  } catch (err) {
    mapConstraintError(err);
  }
  if (results[0]?.meta.changes !== 1) throw conflict("lease not held");
  const decision = toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(id).first<DecisionRow>())!);
  await publish(c.env, [
    { t: "decision.upserted", decision },
    { t: "instruction.upserted", instruction: (await getSummary(db, input.instructionId))! },
  ]);
  return c.json(checked(c.env, DecisionSchema, decision), 201);
});
