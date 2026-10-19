// ランナーの制御: heartbeat・claim・state・PATCH・release（設計書 4.3・5.9・D-3）
import { Hono } from "hono";
import {
  ClaimInput,
  ClaimOutput,
  HeartbeatInput,
  HeartbeatOutput,
  InstructionSummarySchema,
  LIMITS,
  ReleaseInput,
  RunnerInstructionPatch,
  RunnerInstructionState,
} from "@baton/shared";
import { getClaimed, getSummary, transitionAfterUpdate } from "../../db/instructions.ts";
import { getCoo, getProject } from "../../db/projects.ts";
import { loadInstructionParts } from "../../db/details.ts";
import { parseRunnerStatusJson } from "../../db/runners.ts";
import { notifyRunners, publish, publishRunnerStatus } from "../../hub/broadcast.ts";
import { forwardToHub } from "../ws.ts";
import { newId } from "../../lib/crypto.ts";
import { conflict, invalid } from "../../lib/errors.ts";
import { checked, readJson } from "../../lib/validate.ts";
import type { AppEnv } from "../../types.ts";
import { LEASE_WHERE, requireLease } from "./lease.ts";

export const runnerControlRoutes = new Hono<AppEnv>();

runnerControlRoutes.get("/ws", (c) => forwardToHub(c, "runner", c.get("runner").id));

runnerControlRoutes.post("/heartbeat", async (c) => {
  const input = await readJson(c, HeartbeatInput);
  const db = c.env.DB;
  const runner = c.get("runner");
  const now = Date.now();
  const prev = parseRunnerStatusJson(runner.status);
  const wasOnline = runner.last_heartbeat_at !== null && now - runner.last_heartbeat_at <= LIMITS.runnerOnlineWindowMs;

  const stmts = [
    db
      .prepare("UPDATE runners SET version = ?, tailnet_url = ?, last_heartbeat_at = ?, status = ? WHERE id = ?")
      .bind(
        input.version,
        input.tailnetUrl,
        now,
        JSON.stringify({ activeInstructionIds: input.activeInstructionIds, maxConcurrent: input.maxConcurrent }),
        runner.id,
      ),
  ];
  if (input.activeInstructionIds.length > 0) {
    const ph = input.activeInstructionIds.map(() => "?").join(",");
    // 握っている指示の lease を延ばす
    stmts.push(
      db
        .prepare(`UPDATE instructions SET lease_expires_at = ? WHERE id IN (${ph}) AND ${LEASE_WHERE}`)
        .bind(now + LIMITS.leaseMs, ...input.activeInstructionIds, runner.id),
    );
    stmts.push(
      db.prepare(`SELECT id FROM instructions WHERE id IN (${ph}) AND ${LEASE_WHERE}`).bind(...input.activeInstructionIds, runner.id),
    );
  }
  const results = await db.batch(stmts);
  const stillHeld = new Set(((results[2]?.results ?? []) as { id: string }[]).map((r) => r.id));
  const cancelInstructionIds = input.activeInstructionIds.filter((id) => !stillHeld.has(id));

  const changed =
    !wasOnline ||
    prev.activeInstructionIds.length !== input.activeInstructionIds.length ||
    prev.activeInstructionIds.some((id, i) => id !== input.activeInstructionIds[i]) ||
    runner.version !== input.version ||
    runner.tailnet_url !== input.tailnetUrl;
  if (changed) await publishRunnerStatus(c.env);
  return c.json(checked(c.env, HeartbeatOutput, { serverTime: now, cancelInstructionIds }));
});

runnerControlRoutes.post("/claim", async (c) => {
  const input = await readJson(c, ClaimInput);
  const db = c.env.DB;
  const runner = c.get("runner");
  if (input.activeIds.length >= input.maxConcurrent) return c.body(null, 204);
  const now = Date.now();
  const exclude = input.activeIds.length > 0 ? `AND id NOT IN (${input.activeIds.map(() => "?").join(",")})` : "";
  const claimable = `((status = 'queued' AND (not_before IS NULL OR not_before <= ?))
     OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))`;
  // 古い順に候補を見て、条件付きの UPDATE で 1 件だけ握る。
  // 同時に claim が来ても、UPDATE の条件で先に書いた方だけが当たる（1 件は 1 ランナーにだけ渡る）
  const { results: candidates } = await db
    .prepare(`SELECT id, status FROM instructions WHERE ${claimable} ${exclude} ORDER BY created_at, id LIMIT 3`)
    .bind(now, now, ...input.activeIds)
    .all<{ id: string; status: "queued" | "running" }>();
  let claimed: { id: string; status: "queued" | "running" } | null = null;
  for (const cand of candidates) {
    const res = await db
      .prepare(
        `UPDATE instructions
            SET status = 'running', lease_runner_id = ?, lease_expires_at = ?, attempt = attempt + 1,
                not_before = NULL, status_changed_at = ?, updated_at = ?
          WHERE id = ? AND status = ? AND ${claimable}`,
      )
      .bind(runner.id, now + LIMITS.leaseMs, now, now, cand.id, cand.status, now, now)
      .run();
    if (res.meta.changes === 1) {
      claimed = cand;
      break;
    }
  }
  if (!claimed) return c.body(null, 204);

  const [, hasWork] = await db.batch([
    db
      .prepare(
        `INSERT INTO status_transitions (id, instruction_id, from_status, to_status, action, actor, undone, created_at)
         VALUES (?, ?, ?, 'running', 'claim', 'runner', 0, ?)`,
      )
      .bind(newId(), claimed.id, claimed.status, now),
    db
      .prepare(
        "SELECT (EXISTS (SELECT 1 FROM tasks WHERE instruction_id = ?) OR EXISTS (SELECT 1 FROM agent_events WHERE instruction_id = ?)) AS resume",
      )
      .bind(claimed.id, claimed.id),
  ]);
  const instruction = (await getClaimed(db, claimed.id))!;
  await publish(c.env, [{ t: "instruction.upserted", instruction: stripClaimed(instruction) }]);
  const resume = ((hasWork?.results?.[0] as { resume: number } | undefined)?.resume ?? 0) === 1;
  return c.json(checked(c.env, ClaimOutput, { instruction, resume }));
});

/** ClaimedInstruction からブラウザ向けの InstructionSummary に戻す */
function stripClaimed<T extends { feedback: unknown; attempt: unknown }>(v: T) {
  const { feedback: _f, attempt: _a, ...rest } = v;
  return rest as unknown as import("@baton/shared").InstructionSummary;
}

runnerControlRoutes.get("/instructions/:id/state", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const row = await requireLease(db, id, c.get("runner").id);
  const [instruction, parts, coo, routed] = await Promise.all([
    getClaimed(db, id),
    loadInstructionParts(db, id),
    getCoo(db),
    db
      .prepare("SELECT 1 AS ok FROM agent_events WHERE instruction_id = ? AND kind = 'action' AND json_extract(content, '$.stage') = 'route' LIMIT 1")
      .bind(id)
      .first(),
  ]);
  const project = row.project_id ? await getProject(db, row.project_id) : null;
  const state = {
    instruction: instruction!,
    project,
    coo: coo!,
    tasks: parts.tasks,
    decisions: parts.decisions,
    routed: routed !== null,
    nextEventSeq: parts.lastEventSeq + 1,
  };
  return c.json(checked(c.env, RunnerInstructionState, state));
});

runnerControlRoutes.patch("/instructions/:id", async (c) => {
  const input = await readJson(c, RunnerInstructionPatch);
  const db = c.env.DB;
  const id = c.req.param("id");
  const runner = c.get("runner");
  const row = await requireLease(db, id, runner.id);
  const now = Date.now();
  if (input.projectId) {
    const p = await db.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").bind(input.projectId).first();
    if (!p) throw invalid("project not found");
  }
  const sets = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.title !== undefined) sets.push("title = ?"), args.push(input.title);
  if (input.projectId !== undefined) sets.push("project_id = ?"), args.push(input.projectId);
  if (input.resultSummary !== undefined) sets.push("result_summary = ?"), args.push(input.resultSummary);
  if (input.error !== undefined) sets.push("error = ?"), args.push(input.error);
  if (input.status) {
    sets.push("status = ?", "status_changed_at = ?", "lease_runner_id = NULL", "lease_expires_at = NULL");
    args.push(input.status, now);
    if (input.status === "failed") sets.push("completed_at = ?"), args.push(now);
    if (input.status === "review" && input.error === undefined) sets.push("error = NULL");
  }
  const stmts = [db.prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE id = ? AND ${LEASE_WHERE}`).bind(...args, id, runner.id)];
  if (input.status) {
    stmts.push(transitionAfterUpdate(db, { id: newId(), instructionId: id, from: row.status, to: input.status, action: "report", actor: "runner", now }));
  }
  const results = await db.batch(stmts);
  if (results[0]?.meta.changes !== 1) throw conflict("lease not held");
  const summary = (await getSummary(db, id))!;
  await publish(c.env, [{ t: "instruction.upserted", instruction: summary }]);
  return c.json(checked(c.env, InstructionSummarySchema, summary));
});

runnerControlRoutes.post("/instructions/:id/release", async (c) => {
  const input = await readJson(c, ReleaseInput);
  const db = c.env.DB;
  const id = c.req.param("id");
  const runner = c.get("runner");
  await requireLease(db, id, runner.id);
  const now = Date.now();
  const sets = ["status = 'queued'", "status_changed_at = ?", "updated_at = ?", "lease_runner_id = NULL", "lease_expires_at = NULL", "not_before = ?"];
  const args: unknown[] = [now, now, input.notBefore];
  if (input.error !== undefined) sets.push("error = ?"), args.push(input.error);
  const results = await db.batch([
    db.prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE id = ? AND ${LEASE_WHERE}`).bind(...args, id, runner.id),
    transitionAfterUpdate(db, { id: newId(), instructionId: id, from: "running", to: "queued", action: `release:${input.reason}`, actor: "runner", now }),
  ]);
  if (results[0]?.meta.changes !== 1) throw conflict("lease not held");
  await publish(c.env, [{ t: "instruction.upserted", instruction: (await getSummary(db, id))! }]);
  // すぐ取り出せるなら他のランナー（または自分）に合図する
  if (input.notBefore === null || input.notBefore <= now) await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.body(null, 204);
});
