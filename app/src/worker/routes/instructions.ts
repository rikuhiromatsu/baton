// 指示の作成・一覧・詳細・ログ・フリック（設計書 3.4・3.5・4.2）
import { Hono } from "hono";
import {
  CreateInstructionInput,
  InstructionDetailSchema,
  InstructionSummarySchema,
  LIMITS,
  ListEventsOutput,
  ListEventsQuery,
  ListInstructionsOutput,
  ListInstructionsQuery,
  TransitionInput,
  TransitionOutput,
  nextStatus,
  type InstructionStatus,
  type RunnerServerEvent,
  type ServerEvent,
} from "@baton/shared";
import { buildDetail } from "../db/details.ts";
import { getInstructionRow, getSummary, getSummaryRow, listInstructions, transitionAfterUpdate } from "../db/instructions.ts";
import { toAgentEvent, toDecision, type AgentEventRow, type DecisionRow, type InstructionRow } from "../db/rows.ts";
import { notifyRunners, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { ApiError, conflict, invalid, notFound } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const instructionRoutes = new Hono<AppEnv>();

instructionRoutes.get("/", async (c) => {
  const q = ListInstructionsQuery.safeParse({ view: c.req.query("view") ?? undefined, cursor: c.req.query("cursor") ?? undefined });
  if (!q.success) throw invalid("invalid query");
  const out = await listInstructions(c.env.DB, q.data.view, q.data.cursor, Date.now());
  return c.json(checked(c.env, ListInstructionsOutput, out));
});

instructionRoutes.post("/", async (c) => {
  const input = await readJson(c, CreateInstructionInput);
  const db = c.env.DB;
  const user = c.get("user");
  const now = Date.now();

  const existing = await db.prepare("SELECT id FROM instructions WHERE client_id = ?").bind(input.clientId).first<{ id: string }>();
  if (existing) {
    const summary = await getSummary(db, existing.id);
    return c.json(checked(c.env, InstructionSummarySchema, summary!), 200);
  }

  // レート制限: 1 分あたり 30 件（設計書 6.6）
  const recent = await db
    .prepare("SELECT count(*) AS n FROM instructions WHERE created_by = ? AND created_at > ?")
    .bind(user.id, now - 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LIMITS.createInstructionPerMinute) {
    throw new ApiError("rate_limited", "too many instructions", { retryAfterMs: 60_000 });
  }

  const id = newId();
  const res = await db
    .prepare(
      `INSERT INTO instructions (id, client_id, created_by, body, status, status_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT(client_id) DO NOTHING`,
    )
    .bind(id, input.clientId, user.id, input.body, now, now, now)
    .run();
  if (res.meta.changes === 0) {
    // 同じ clientId が同時に来た
    const again = await db.prepare("SELECT id FROM instructions WHERE client_id = ?").bind(input.clientId).first<{ id: string }>();
    const summary = again ? await getSummary(db, again.id) : null;
    if (!summary) throw conflict("duplicate clientId");
    return c.json(checked(c.env, InstructionSummarySchema, summary), 200);
  }
  const summary = (await getSummary(db, id))!;
  await publish(c.env, [{ t: "instruction.upserted", instruction: summary }]);
  await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.json(checked(c.env, InstructionSummarySchema, summary), 201);
});

instructionRoutes.get("/:id", async (c) => {
  const row = await getSummaryRow(c.env.DB, c.req.param("id"));
  if (!row) throw notFound("instruction not found");
  return c.json(checked(c.env, InstructionDetailSchema, await buildDetail(c.env.DB, row)));
});

instructionRoutes.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  const q = ListEventsQuery.safeParse({ after: c.req.query("after") ?? undefined, limit: c.req.query("limit") ?? undefined });
  if (!q.success) throw invalid("invalid query");
  const exists = await c.env.DB.prepare("SELECT 1 AS ok FROM instructions WHERE id = ?").bind(id).first();
  if (!exists) throw notFound("instruction not found");
  const { results } = await c.env.DB.prepare("SELECT * FROM agent_events WHERE instruction_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .bind(id, q.data.after, q.data.limit)
    .all<AgentEventRow>();
  return c.json(checked(c.env, ListEventsOutput, { items: results.map(toAgentEvent) }));
});

/** アーカイブ前の状態（restore 用）。直近の「archived への遷移」の from */
async function archivedFrom(db: D1Database, id: string): Promise<InstructionStatus | undefined> {
  const row = await db
    .prepare(
      "SELECT from_status FROM status_transitions WHERE instruction_id = ? AND to_status = 'archived' AND undone = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(id)
    .first<{ from_status: InstructionStatus }>();
  return row?.from_status;
}

instructionRoutes.post("/:id/transition", async (c) => {
  const input = await readJson(c, TransitionInput);
  const db = c.env.DB;
  const id = c.req.param("id");
  const now = Date.now();
  const inst = await getInstructionRow(db, id);
  if (!inst) throw notFound("instruction not found");
  if (inst.status !== input.expectedStatus) {
    throw conflict("status changed", { status: inst.status });
  }
  const to = nextStatus(inst.status, input.action, input.action === "restore" ? await archivedFrom(db, id) : undefined);
  if (to === null) throw conflict("transition not allowed", { status: inst.status, action: input.action });
  if (input.action === "send_back" && !input.comment?.trim()) throw invalid("comment is required for send_back");

  const transitionId = newId();
  const stmts = [ceoUpdate(db, inst, input.action, to, input.comment?.trim() ?? null, now)];
  stmts.push(transitionAfterUpdate(db, { id: transitionId, instructionId: id, from: inst.status, to, action: input.action, actor: "ceo", now }));
  // 取消では未回答の判断も閉じる（再開したら必要なら聞き直す）
  if (input.action === "cancel") {
    // 遷移が記録されたとき（＝取消が当たったとき）だけ閉じる
    stmts.push(
      db
        .prepare("UPDATE decisions SET status = 'canceled' WHERE instruction_id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM status_transitions WHERE id = ?)")
        .bind(id, transitionId),
    );
  }
  const results = await db.batch(stmts);
  if (results[0]?.meta.changes !== 1) throw conflict("status changed");

  const summary = (await getSummary(db, id))!;
  const events: ServerEvent[] = [{ t: "instruction.upserted", instruction: summary }];
  if (input.action === "cancel") {
    const { results: canceled } = await db
      .prepare("SELECT * FROM decisions WHERE instruction_id = ? AND status = 'canceled'")
      .bind(id)
      .all<DecisionRow>();
    for (const d of canceled) events.push({ t: "decision.upserted", decision: toDecision(d) });
  }
  await publish(c.env, events);
  await notifyRunners(c.env, runnerEventsFor(id, input.action, to));
  return c.json(checked(c.env, TransitionOutput, { instruction: summary, transitionId }));
});

/** CEO の操作 1 つ分の UPDATE（今の状態が変わっていないときだけ当たる） */
function ceoUpdate(db: D1Database, inst: InstructionRow, action: string, to: InstructionStatus, comment: string | null, now: number) {
  const sets = ["status = ?", "status_changed_at = ?", "updated_at = ?"];
  const args: unknown[] = [to, now, now];
  if (to === "done") sets.push("completed_at = ?"), args.push(now);
  if (to === "queued" || to === "canceled") {
    sets.push("lease_runner_id = NULL", "lease_expires_at = NULL");
  }
  if (to === "queued") sets.push("not_before = NULL");
  if (action === "send_back") sets.push("feedback = ?"), args.push(comment);
  return db
    .prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
    .bind(...args, inst.id, inst.status);
}

function runnerEventsFor(id: string, action: string, to: InstructionStatus): RunnerServerEvent[] {
  if (action === "cancel") return [{ t: "instruction.cancel", instructionId: id }];
  if (to === "queued") return [{ t: "work.available" }];
  return [];
}
