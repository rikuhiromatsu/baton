// 指示の一覧・詳細・差分・フリック（v1 設計書 3.4・3.5、DESIGN-v2 4.4・12.2）。
// v2 では CEO が指示を直接作らない（POST /api/instructions は無い。D-73）
import { Hono } from "hono";
import {
  COO_THREAD_ID,
  InstructionDetailSchema,
  ListInstructionsOutput,
  ListInstructionsQuery,
  TransitionInput,
  TransitionOutput,
  UI_TEXT_V2,
  WorkspaceDiffSchema,
  nextStatus,
  type CeoAction,
  type InstructionStatus,
  type RunnerServerEvent,
} from "@baton/shared";
import { buildDetail, buildDiff } from "../db/detail.ts";
import { getSummary, listInstructions, requireInstruction, transitionAfterUpdate } from "../db/instructions.ts";
import { leaderThreadIdOf } from "../db/projects.ts";
import { toDecision, type DecisionRow, type InstructionRow } from "../db/rows.ts";
import { getThread, inboxInsertStatements, noticeStatements } from "../db/threads.ts";
import { afterMessages, instructionEvents, notifyRunners, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { conflict, invalid } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import { assertCeoMessageRate, postCeoMessage } from "../services/conversation.ts";
import type { AppEnv } from "../types.ts";

export const instructionRoutes = new Hono<AppEnv>();

instructionRoutes.get("/", async (c) => {
  const q = ListInstructionsQuery.safeParse({
    view: c.req.query("view") || undefined,
    projectId: c.req.query("projectId") || undefined,
    cursor: c.req.query("cursor") || undefined,
  });
  if (!q.success) throw invalid("invalid query");
  const out = await listInstructions(c.env.DB, q.data, Date.now());
  return c.json(checked(c.env, ListInstructionsOutput, out));
});

instructionRoutes.get("/:id", async (c) => {
  const row = await requireInstruction(c.env.DB, c.req.param("id"));
  return c.json(checked(c.env, InstructionDetailSchema, await buildDetail(c.env.DB, row)));
});

instructionRoutes.get("/:id/diff", async (c) => {
  const row = await requireInstruction(c.env.DB, c.req.param("id"));
  return c.json(checked(c.env, WorkspaceDiffSchema, await buildDiff(c.env.DB, row.id)));
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
  const inst = await requireInstruction(db, id);
  if (inst.status !== input.expectedStatus) throw conflict("status changed", { status: inst.status });
  const to = nextStatus(inst.status, input.action, input.action === "restore" ? await archivedFrom(db, id) : undefined);
  if (to === null) throw conflict("transition not allowed", { status: inst.status, action: input.action });
  const comment = input.comment?.trim() ?? "";
  if (input.action === "send_back" && !comment) throw invalid("comment is required for send_back");
  // 差し戻しのコメントは遷移の後に CEO の発言として入る。発言の上限に当たるなら、遷移を確定する前に断る（Codex 指摘）
  if (input.action === "send_back") await assertCeoMessageRate(db, now);

  const transitionId = newId();
  const stmts = [ceoUpdate(db, inst, input.action, to, comment || null, now)];
  stmts.push(transitionAfterUpdate(db, { id: transitionId, instructionId: id, from: inst.status, to, action: input.action, actor: "ceo", now }));
  const applied = (sql: string) => `${sql} AND EXISTS (SELECT 1 FROM status_transitions WHERE id = '${transitionId}')`;
  if (input.action === "cancel") {
    // 取消が当たったときだけ、未回答の判断と届けていない追加の依頼を閉じる
    stmts.push(db.prepare(applied("UPDATE decisions SET status = 'canceled' WHERE instruction_id = ? AND status = 'open'")).bind(id));
    stmts.push(db.prepare(applied("UPDATE session_inputs SET status = 'canceled' WHERE instruction_id = ? AND status = 'pending'")).bind(id));
  }
  const results = await db.batch(stmts);
  if (results[0]?.meta.changes !== 1) throw conflict("status changed");

  // 会話への反映（4.4）
  const messageIds = await reflectInConversation(c.env, inst, input.action, comment, c.get("user").id, now);

  const events = await instructionEvents(c.env, [id]);
  if (input.action === "cancel") {
    const { results: canceled } = await db.prepare("SELECT * FROM decisions WHERE instruction_id = ? AND status = 'canceled'").bind(id).all<DecisionRow>();
    for (const d of canceled) events.push({ t: "decision.upserted", decision: toDecision(d) });
  }
  await publish(c.env, events);
  if (messageIds.length > 0) await afterMessages(c.env, messageIds, { push: false });
  await notifyRunners(c.env, runnerEventsFor(id, input.action, to));
  const summary = (await getSummary(db, id))!;
  return c.json(checked(c.env, TransitionOutput, { instruction: summary, transitionId }));
});

/** CEO の操作 1 つ分の UPDATE（今の状態が変わっていないときだけ当たる） */
function ceoUpdate(db: D1Database, inst: InstructionRow, action: CeoAction, to: InstructionStatus, comment: string | null, now: number) {
  const sets = ["status = ?", "status_changed_at = ?", "updated_at = ?"];
  const args: unknown[] = [to, now, now];
  if (to === "done") sets.push("completed_at = ?", "finalized_at = NULL"), args.push(now);
  if (to === "queued" || to === "canceled") sets.push("lease_runner_id = NULL", "lease_expires_at = NULL");
  if (to === "queued") sets.push("not_before = NULL", "phase = 'coo'", "error = NULL");
  if (action === "send_back") sets.push("feedback = ?"), args.push(comment);
  return db.prepare(`UPDATE instructions SET ${sets.join(", ")} WHERE id = ? AND status = ?`).bind(...args, inst.id, inst.status);
}

/** 承認・差し戻し・取消・再実行を COO・リーダーのスレッドに反映し、作った発言の ID を返す */
async function reflectInConversation(
  env: AppEnv["Bindings"],
  inst: InstructionRow,
  action: CeoAction,
  comment: string,
  userId: string,
  now: number,
): Promise<string[]> {
  const db = env.DB;
  const label = inst.title ?? inst.body.slice(0, 40);
  const leaderThreadId = inst.project_id ? leaderThreadIdOf(inst.project_id) : null;
  const leaderThread = leaderThreadId ? await getThread(db, leaderThreadId) : null;
  const stmts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  const notice = (threadId: string, body: string, kind: string) => {
    const n = noticeStatements(db, threadId, body, { notice: kind }, inst.id, now);
    stmts.push(...n.stmts);
    ids.push(n.id);
  };
  const event = (threadId: string, wakes: boolean, text: string, type: string) => {
    stmts.push(...inboxInsertStatements(db, { threadId, kind: "instruction_event", wakes, instructionId: inst.id, payload: { type, text } }, now).stmts);
  };
  switch (action) {
    case "approve":
      notice(COO_THREAD_ID, UI_TEXT_V2.notices.approve, "approve");
      event(COO_THREAD_ID, false, `CEO が指示「${label}」を承認した`, "approved");
      if (leaderThread) event(leaderThread.id, false, `CEO が指示「${label}」を承認した`, "approved");
      break;
    case "cancel":
      notice(COO_THREAD_ID, UI_TEXT_V2.notices.cancel, "cancel");
      event(COO_THREAD_ID, false, `CEO が指示「${label}」を取り消した`, "canceled");
      if (leaderThread) {
        notice(leaderThread.id, UI_TEXT_V2.notices.cancel, "cancel");
        event(leaderThread.id, false, `CEO が指示「${label}」を取り消した`, "canceled");
      }
      break;
    case "retry":
      notice(COO_THREAD_ID, UI_TEXT_V2.notices.retry, "retry");
      event(COO_THREAD_ID, true, `CEO が指示「${label}」の再実行を求めた`, "retry");
      break;
    case "send_back": {
      // コメントは CEO の発言として COO スレッドへ（指示のカード付き）。COO のターン
      await postCeoMessage(env, { threadId: COO_THREAD_ID, userId, clientId: null, body: comment, instructionId: inst.id, sendBack: true });
      break;
    }
    default:
      break;
  }
  if (stmts.length > 0) await db.batch(stmts);
  return ids;
}

function runnerEventsFor(id: string, action: string, to: InstructionStatus): RunnerServerEvent[] {
  if (action === "cancel") return [{ t: "instruction.cancel", instructionId: id }];
  if (to === "queued" || to === "done") return [{ t: "work.available" }];
  return [];
}
