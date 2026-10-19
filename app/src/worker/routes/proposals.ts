// プロジェクト案を立てる・見送る（DESIGN-v2 3.2・12.2）
import { Hono } from "hono";
import { AcceptProposalInput, AcceptProposalOutput, COO_THREAD_ID, GetProposalOutput } from "@baton/shared";
import { getProject } from "../db/projects.ts";
import { inboxInsertStatements } from "../db/threads.ts";
import { notifyRunners, projectEvents, publish, threadEvents } from "../hub/broadcast.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import { acceptProposal, getProposal } from "../services/projects.ts";
import type { AppEnv } from "../types.ts";

export const proposalRoutes = new Hono<AppEnv>();

/** 1 つの案（再読み込みでカードを描き直す） */
proposalRoutes.get("/:id", async (c) => {
  const proposal = await getProposal(c.env.DB, c.req.param("id"));
  if (!proposal) throw notFound("proposal not found");
  return c.json(checked(c.env, GetProposalOutput, { proposal }));
});

proposalRoutes.post("/:id/accept", async (c) => {
  const input = await readJson(c, AcceptProposalInput);
  const { projectId, leaderThreadId } = await acceptProposal(c.env, c.req.param("id"), input.workspace);
  const project = (await getProject(c.env.DB, projectId))!;
  const proposal = (await getProposal(c.env.DB, c.req.param("id")))!;
  await publish(c.env, [
    { t: "project_proposal.upserted", proposal },
    ...(await projectEvents(c.env, projectId)),
    ...(await threadEvents(c.env, [leaderThreadId, COO_THREAD_ID])),
  ]);
  await notifyRunners(c.env, [{ t: "work.available" }]);
  return c.json(checked(c.env, AcceptProposalOutput, { project, proposal }), 201);
});

proposalRoutes.post("/:id/decline", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const before = await getProposal(db, id);
  if (!before) throw notFound("proposal not found");
  const now = Date.now();
  const res = await db.prepare("UPDATE project_proposals SET status = 'declined', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now, id).run();
  if (res.meta.changes !== 1) throw conflict("proposal is not pending", { status: before.status });
  // COO には知らせるだけ（ターンは起こさない）
  const inbox = inboxInsertStatements(db, { threadId: COO_THREAD_ID, kind: "instruction_event", wakes: false, payload: { text: `CEO がプロジェクト案「${before.name}」を見送った`, proposalId: id } }, now);
  await db.batch(inbox.stmts);
  await publish(c.env, [{ t: "project_proposal.upserted", proposal: (await getProposal(db, id))! }]);
  return c.body(null, 204);
});
