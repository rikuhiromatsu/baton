// POST /api/decisions/:id/answer（設計書 5.7）
import { Hono } from "hono";
import { AnswerDecisionInput, AnswerDecisionOutput } from "@baton/shared";
import { getSummary, transitionAfterUpdate } from "../db/instructions.ts";
import { toDecision, type DecisionRow } from "../db/rows.ts";
import { notifyRunners, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const decisionRoutes = new Hono<AppEnv>();

decisionRoutes.post("/:id/answer", async (c) => {
  const input = await readJson(c, AnswerDecisionInput);
  const db = c.env.DB;
  const now = Date.now();
  const d = await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(c.req.param("id")).first<DecisionRow>();
  if (!d) throw notFound("decision not found");
  if (d.status !== "open") throw conflict("decision already closed", { status: d.status });
  const inst = await db.prepare("SELECT status FROM instructions WHERE id = ?").bind(d.instruction_id).first<{ status: string }>();
  if (inst?.status !== "needs_decision") throw conflict("instruction is not waiting for a decision", { status: inst?.status });

  const results = await db.batch([
    db.prepare("UPDATE decisions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'").bind(input.answer, now, d.id),
    db
      .prepare(
        `UPDATE instructions SET status = 'queued', status_changed_at = ?, updated_at = ?, lease_runner_id = NULL, lease_expires_at = NULL, not_before = NULL
         WHERE id = ? AND status = 'needs_decision' AND changes() = 1`,
      )
      .bind(now, now, d.instruction_id),
    transitionAfterUpdate(db, { id: newId(), instructionId: d.instruction_id, from: "needs_decision", to: "queued", action: "answer", actor: "ceo", now }),
  ]);
  if (results[0]?.meta.changes !== 1) throw conflict("decision already closed");

  const decision = toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(d.id).first<DecisionRow>())!);
  const instruction = (await getSummary(db, d.instruction_id))!;
  await publish(c.env, [
    { t: "decision.upserted", decision },
    { t: "instruction.upserted", instruction },
  ]);
  await notifyRunners(c.env, [{ t: "decision.answered", instructionId: d.instruction_id }]);
  return c.json(checked(c.env, AnswerDecisionOutput, { decision, instruction }));
});
