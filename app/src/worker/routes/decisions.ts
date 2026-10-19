// POST /api/decisions/:id/answer（承認・中断からの再開・v1 の質問。DESIGN-v2 7.6・D-45・D-53）
import { Hono } from "hono";
import { AnswerDecisionInput, AnswerDecisionOutput } from "@baton/shared";
import { getSummary, requireInstruction, transitionAfterUpdate } from "../db/instructions.ts";
import { toDecision, type DecisionRow } from "../db/rows.ts";
import { instructionEvents, notifyRunners, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { parseJson } from "../lib/json.ts";
import { conflict, invalid, notFound } from "../lib/errors.ts";
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
  // 承認はカードの「許可」「拒否」で決める（フリックだけでは許可しない。D-53）
  if (d.kind === "approval" && !input.verdict) throw invalid("verdict is required for approval");
  const inst = await requireInstruction(db, d.instruction_id);
  if (!["running", "needs_decision", "queued"].includes(inst.status)) throw conflict("instruction is not waiting for a decision", { status: inst.status });

  const options = parseJson<string[]>(d.options, []);
  const answer = input.answer ?? (input.optionIndex !== undefined ? (options[input.optionIndex] ?? null) : null);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE decisions SET status = 'answered', answer = ?, verdict = ?, answered_at = ? WHERE id = ? AND status = 'open'")
      .bind(answer, input.verdict ?? null, now, d.id),
  ];
  if (inst.status === "needs_decision") {
    // 回答で再開（needs_decision → running、actor ceo。4.4）。他に開いた判断が残っていれば判断待ちのまま
    stmts.push(
      db
        .prepare(
          `UPDATE instructions SET status = 'running', status_changed_at = ?, updated_at = ?, not_before = NULL
            WHERE id = ? AND status = 'needs_decision' AND changes() = 1
              AND NOT EXISTS (SELECT 1 FROM decisions WHERE instruction_id = ? AND status = 'open')`,
        )
        .bind(now, now, d.instruction_id, d.instruction_id),
      transitionAfterUpdate(db, { id: newId(), instructionId: d.instruction_id, from: "needs_decision", to: "running", action: "answer", actor: "ceo", now }),
    );
  }
  const results = await db.batch(stmts);
  if (results[0]?.meta.changes !== 1) throw conflict("decision already closed");

  const decision = toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(d.id).first<DecisionRow>())!);
  await publish(c.env, [{ t: "decision.upserted", decision }, ...(await instructionEvents(c.env, [d.instruction_id]))]);
  await notifyRunners(c.env, [{ t: "decision.answered", decisionId: d.id, sessionId: d.session_id, instructionId: d.instruction_id }, { t: "work.available" }]);
  const instruction = (await getSummary(db, d.instruction_id))!;
  return c.json(checked(c.env, AnswerDecisionOutput, { decision, instruction }));
});
