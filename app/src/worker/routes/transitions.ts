// POST /api/transitions/:id/undo（設計書 3.5・D-25）
import { Hono } from "hono";
import { LIMITS, NO_UNDO_ACTIONS, UndoOutput, type CeoAction, type InstructionStatus, type RunnerServerEvent } from "@baton/shared";
import { getSummary, transitionAfterUpdate } from "../db/instructions.ts";
import type { TransitionRow } from "../db/rows.ts";
import { notifyRunners, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { checked } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

const UNDOABLE: readonly string[] = ["approve", "cancel", "archive", "retry", "restore"] satisfies CeoAction[];

export const transitionRoutes = new Hono<AppEnv>();

transitionRoutes.post("/:id/undo", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const t = await db.prepare("SELECT * FROM status_transitions WHERE id = ?").bind(c.req.param("id")).first<TransitionRow>();
  if (!t || t.actor !== "ceo") throw notFound("transition not found");
  if (!UNDOABLE.includes(t.action) || (NO_UNDO_ACTIONS as readonly string[]).includes(t.action)) throw conflict("not undoable");
  if (t.undone === 1) throw conflict("already undone");
  if (now - t.created_at > LIMITS.undoServerWindowMs) throw conflict("undo window expired");
  // 直後に他の遷移がないこと
  const latest = await db
    .prepare("SELECT id FROM status_transitions WHERE instruction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(t.instruction_id)
    .first<{ id: string }>();
  if (latest?.id !== t.id) throw conflict("instruction changed after this transition");

  // 取消の取り消しは「元の状態」ではなく queued（ランナーは既に止めているため）
  const back: InstructionStatus = t.action === "cancel" ? "queued" : t.from_status;
  const sets = ["status = ?", "status_changed_at = ?", "updated_at = ?"];
  const args: unknown[] = [back, now, now];
  if (t.action === "approve") sets.push("completed_at = NULL");
  if (back === "queued") sets.push("lease_runner_id = NULL", "lease_expires_at = NULL", "not_before = NULL");
  const undoId = newId();
  const results = await db.batch([
    db.prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE id = ? AND status = ?`).bind(...args, t.instruction_id, t.to_status),
    transitionAfterUpdate(db, { id: undoId, instructionId: t.instruction_id, from: t.to_status, to: back, action: "undo", actor: "ceo", now }),
    db
      .prepare("UPDATE status_transitions SET undone = 1 WHERE id = ? AND EXISTS (SELECT 1 FROM status_transitions WHERE id = ?)")
      .bind(t.id, undoId),
  ]);
  if (results[0]?.meta.changes !== 1) throw conflict("status changed");

  const summary = (await getSummary(db, t.instruction_id))!;
  await publish(c.env, [{ t: "instruction.upserted", instruction: summary }]);
  const runnerEvents: RunnerServerEvent[] = back === "queued" ? [{ t: "work.available" }] : [];
  await notifyRunners(c.env, runnerEvents);
  return c.json(checked(c.env, UndoOutput, { instruction: summary }));
});
