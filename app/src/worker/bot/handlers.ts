// 秘書 bot の道具の処理（DESIGN-v2 11.4・11.6・D-90・D-91）。MCP と HTTP API はこの 1 か所を呼ぶ（入出力の変換だけ）
import {
  BOT_TOOLS,
  COO_THREAD_ID,
  LIMITS,
  STATUS_LABELS,
  isBotToolName,
  type AuthorKind,
  type BotToolName,
  type BotToolOutput,
} from "@baton/shared";
import { z } from "zod";
import type { Env } from "../env.ts";
import { getSummaries, getSummary } from "../db/instructions.ts";
import { buildSidebar, projectCounts } from "../db/org.ts";
import { getProject, leaderThreadIdOf, listProjects } from "../db/projects.ts";
import { botScopes, toDecision, type BotTokenRow, type DecisionRow, type MessageRow, type WorkspaceRow } from "../db/rows.ts";
import { getQuota } from "../db/runners.ts";
import { MESSAGE_SELECT } from "../db/threads.ts";
import { hubStub, publish } from "../hub/broadcast.ts";
import { newId } from "../lib/crypto.ts";
import { clip } from "../lib/json.ts";
import { DAY_MS } from "../lib/time.ts";
import { ApiError } from "../lib/errors.ts";
import { postSecretaryMessage } from "../services/conversation.ts";

export type BotVia = "mcp" | "http";

export type BotCallResult =
  | { ok: true; summary: string; data: Record<string, unknown> }
  | { ok: false; kind: "unknown_tool" | "forbidden" | "invalid" | "not_found" | "rate_limited" | "error"; message: string; retryAfterSec?: number; details?: unknown };

class ToolError extends Error {
  readonly kind: "invalid" | "not_found" | "rate_limited";
  readonly retryAfterSec?: number;
  constructor(kind: "invalid" | "not_found" | "rate_limited", message: string, retryAfterSec?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterSec = retryAfterSec;
  }
}

const AUTHOR_LABELS: Record<AuthorKind, "CEO" | "COO" | "リーダー" | "秘書" | "システム"> = {
  ceo: "CEO",
  coo: "COO",
  leader: "リーダー",
  member: "システム",
  system: "システム",
  secretary: "秘書",
};

const workspaceView = (p: { workspaceKind: "baton" | "repo"; repoName: string | null }) =>
  p.workspaceKind === "repo" && p.repoName ? { kind: "repo" as const, repoName: p.repoName } : { kind: p.workspaceKind };

// ───────────── 道具ごとの処理 ─────────────

type Ctx = { env: Env; token: BotTokenRow; via: BotVia; now: number };
type Handler<N extends BotToolName> = (ctx: Ctx, input: z.infer<(typeof BOT_TOOLS)[N]["input"]>) => Promise<{ summary: string; data: BotToolOutput<N>; target?: string | null }>;

const overview: Handler<"baton_overview"> = async ({ env, now }) => {
  const db = env.DB;
  const sidebar = await buildSidebar(db, null, now);
  const [waiting, coo, quota] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT count(*) FROM decisions WHERE status = 'open' AND kind = 'approval') AS approvals,
           (SELECT count(*) FROM decisions WHERE status = 'open' AND kind <> 'approval') AS decisions,
           (SELECT count(*) FROM instructions WHERE status = 'review') AS reviews,
           (SELECT count(*) FROM threads WHERE awaiting_reply = 1) AS questions,
           (SELECT awaiting_reply FROM threads WHERE id = ?) AS coo_awaiting`,
      )
      .bind(COO_THREAD_ID)
      .first<{ approvals: number; decisions: number; reviews: number; questions: number; coo_awaiting: number | null }>(),
    db.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.status = 'complete' ORDER BY m.seq DESC LIMIT 1`).bind(COO_THREAD_ID).first<MessageRow>(),
    getQuota(db),
  ]);
  const data: BotToolOutput<"baton_overview"> = {
    projects: sidebar.items.map((s) => ({
      id: s.project.id,
      name: s.project.name,
      goal: s.project.goal,
      workspace: workspaceView(s.project),
      counts: s.counts,
      activeAgents: s.activeAgents,
      lastActivityAt: s.lastActivityAt,
    })),
    waitingForCeo: {
      approvals: waiting?.approvals ?? 0,
      decisions: waiting?.decisions ?? 0,
      reviews: waiting?.reviews ?? 0,
      questions: waiting?.questions ?? 0,
    },
    coo: {
      lastMessage: coo ? { author: AUTHOR_LABELS[coo.author_kind], body: clip(coo.body, LIMITS.broadcastMaxChars), at: coo.created_at } : null,
      awaitingReply: (waiting?.coo_awaiting ?? 0) === 1,
    },
    quota: { fiveHour: quota.fiveHour, sevenDay: quota.sevenDay },
  };
  const w = data.waitingForCeo;
  const summary = `進行中のプロジェクト ${data.projects.length} 件。CEO の返事待ち: 承認 ${w.approvals}・判断 ${w.decisions}・確認 ${w.reviews}・質問 ${w.questions}。`;
  return { summary, data };
};

const listProjectsTool: Handler<"baton_list_projects"> = async ({ env, now }, input) => {
  const db = env.DB;
  const projects = await listProjects(db, { activeOnly: (input.status ?? "active") === "active" });
  const items = [];
  for (const p of projects) {
    items.push({
      id: p.id,
      name: p.name,
      goal: p.goal,
      workspace: workspaceView(p),
      team: p.agents.filter((a) => a.active && a.role !== "coo").map((a) => ({ name: a.name, role: a.role as "leader" | "member", profile: a.profile })),
      counts: await projectCounts(db, p.id, now),
    });
  }
  return { summary: `プロジェクト ${items.length} 件。${items.map((i) => i.name).join("、")}`, data: { items } };
};

const getProjectTool: Handler<"baton_get_project"> = async ({ env }, input) => {
  const db = env.DB;
  const p = await getProject(db, input.projectId);
  if (!p) throw new ToolError("not_found", "プロジェクトが見つかりません");
  const { results: open } = await db
    .prepare("SELECT id FROM instructions WHERE project_id = ? AND status IN ('queued','running','needs_decision','review') ORDER BY created_at")
    .bind(p.id)
    .all<{ id: string }>();
  const summaries = await getSummaries(db, open.map((r) => r.id));
  const { results: msgs } = await db
    .prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.status = 'complete' ORDER BY m.seq DESC LIMIT 5`)
    .bind(leaderThreadIdOf(p.id))
    .all<MessageRow>();
  const data: BotToolOutput<"baton_get_project"> = {
    project: { id: p.id, name: p.name, goal: p.goal, workspace: workspaceView(p) },
    openInstructions: summaries.map((s) => ({ id: s.id, title: s.title ?? clip(s.body, 60), status: s.status, phase: s.phase, activity: s.activity, updatedAt: s.updatedAt })),
    leaderThread: { lastMessages: msgs.reverse().map((m) => ({ author: AUTHOR_LABELS[m.author_kind], body: clip(m.body, 500), at: m.created_at })) },
  };
  return { summary: `${p.name}: 進行中の指示 ${data.openInstructions.length} 件`, data, target: p.id };
};

const listWaiting: Handler<"baton_list_waiting"> = async ({ env }, input) => {
  const db = env.DB;
  const kinds = input.kind ? [input.kind] : (["approval", "decision", "review", "question"] as const);
  const items: BotToolOutput<"baton_list_waiting">["items"] = [];
  if (kinds.includes("approval") || kinds.includes("decision")) {
    const { results } = await db
      .prepare(
        `SELECT d.*, COALESCE(i.title, substr(i.body, 1, 60)) AS i_title, p.name AS project_name, a.name AS agent_name
           FROM decisions d JOIN instructions i ON i.id = d.instruction_id LEFT JOIN projects p ON p.id = i.project_id LEFT JOIN agents a ON a.id = d.asked_by_agent_id
          WHERE d.status = 'open' ORDER BY d.created_at`,
      )
      .all<DecisionRow & { i_title: string; project_name: string | null; agent_name: string | null }>();
    for (const r of results) {
      const kind = r.kind === "approval" ? "approval" : "decision";
      if (!kinds.includes(kind)) continue;
      const d = toDecision(r);
      items.push({
        kind,
        id: d.id,
        title: r.i_title,
        projectName: r.project_name,
        askedBy: r.agent_name ?? "メンバー",
        summary: clip(d.question, 500),
        since: d.createdAt,
        ...(d.suggestion ? { suggestion: { text: d.suggestion, verdict: d.suggestionVerdict } } : {}),
      });
    }
  }
  if (kinds.includes("review")) {
    const { results } = await db
      .prepare(
        `SELECT i.id, COALESCE(i.title, substr(i.body, 1, 60)) AS title, p.name AS project_name, i.result_summary, i.status_changed_at
           FROM instructions i LEFT JOIN projects p ON p.id = i.project_id WHERE i.status = 'review' ORDER BY i.status_changed_at`,
      )
      .all<{ id: string; title: string; project_name: string | null; result_summary: string | null; status_changed_at: number }>();
    for (const r of results) {
      items.push({ kind: "review", id: r.id, title: r.title, projectName: r.project_name, askedBy: "COO", summary: clip(r.result_summary ?? "", 500), since: r.status_changed_at });
    }
  }
  if (kinds.includes("question")) {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.kind, p.name AS project_name, a.name AS agent_name, t.updated_at,
                (SELECT m.body FROM thread_messages m WHERE m.thread_id = t.id AND m.author_kind IN ('coo','leader') AND m.status = 'complete' ORDER BY m.seq DESC LIMIT 1) AS body,
                (SELECT m.created_at FROM thread_messages m WHERE m.thread_id = t.id AND m.author_kind IN ('coo','leader') AND m.status = 'complete' ORDER BY m.seq DESC LIMIT 1) AS at
           FROM threads t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN agents a ON a.id = t.agent_id
          WHERE t.awaiting_reply = 1 ORDER BY t.updated_at`,
      )
      .all<{ id: string; kind: string; project_name: string | null; agent_name: string | null; updated_at: number; body: string | null; at: number | null }>();
    for (const r of results) {
      const askedBy = r.kind === "coo" ? "COO" : `リーダー（${r.agent_name ?? ""}）`;
      items.push({ kind: "question", id: r.id, title: askedBy, projectName: r.project_name, askedBy, summary: clip(r.body ?? "", 500), since: r.at ?? r.updated_at });
    }
  }
  return { summary: items.length === 0 ? "CEO の返事を待っているものはありません。" : `CEO の返事を待っているもの ${items.length} 件。`, data: { items } };
};

const getInstructionTool: Handler<"baton_get_instruction"> = async ({ env }, input) => {
  const db = env.DB;
  const s = await getSummary(db, input.instructionId);
  if (!s) throw new ToolError("not_found", "指示が見つかりません");
  const { results: tasks } = await db
    .prepare(
      `SELECT t.title, t.status, a.name AS assignee FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent_id
        WHERE t.instruction_id = ? AND t.kind = 'work' ORDER BY t.round, t.seq`,
    )
    .bind(s.id)
    .all<{ title: string; status: string; assignee: string | null }>();
  const ws = await db
    .prepare("SELECT * FROM workspaces WHERE instruction_id = ? AND purpose = 'integration' ORDER BY created_at DESC LIMIT 1")
    .bind(s.id)
    .first<WorkspaceRow>();
  const data: BotToolOutput<"baton_get_instruction"> = {
    id: s.id,
    title: s.title ?? clip(s.body, 60),
    status: s.status,
    phase: s.phase,
    project: s.projectId && s.projectName ? { id: s.projectId, name: s.projectName } : null,
    ...(s.resultSummary ? { report: clip(s.resultSummary, 4000) } : {}),
    tasks: tasks.map((t) => ({ title: t.title, assignee: t.assignee, status: t.status })),
    ...(ws ? { branch: ws.branch } : {}),
    lastActivity: s.activity,
    createdAt: s.createdAt,
  };
  return { summary: `「${data.title}」は ${STATUS_LABELS[s.status]}`, data, target: s.id };
};

const readCooThread: Handler<"baton_read_coo_thread"> = async ({ env }, input) => {
  const limit = input.limit ?? LIMITS.botReadLimitDefault;
  const { results } = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.status = 'complete' AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
    .bind(COO_THREAD_ID, input.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
    .all<MessageRow>();
  const items = results.map((m) => ({
    seq: m.seq,
    author: AUTHOR_LABELS[m.author_kind],
    body: clip(m.body, LIMITS.broadcastMaxChars),
    at: m.created_at,
    ...(m.instruction_id ? { instructionId: m.instruction_id } : {}),
  }));
  return { summary: `COO との会話 ${items.length} 件（新しい順）`, data: { items } };
};

/**
 * トークンごとの枠を原子的に予約する（11.6・D-119）。間隔と日次件数を満たすときだけ、1 文の条件付き INSERT で行を入れる。
 * 判定と予約が 1 文なので、並行した呼び出しでも上限を超えない。同じ requestId は枠を再消費しない（"duplicate"）。
 * 予約した行は送信が失敗しても消さない（件数に数える）。
 */
async function reserveSlot(
  db: D1Database,
  input: { tokenId: string; action: string; requestId: string; now: number; intervalMs: number; perDay: number; dailyMessage: string },
): Promise<"reserved" | "duplicate"> {
  const { tokenId, action, requestId, now, intervalMs, perDay } = input;
  const r = await db
    .prepare(
      `INSERT INTO bot_rate_slots (token_id, action, request_id, created_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE NOT EXISTS (SELECT 1 FROM bot_rate_slots WHERE token_id = ?1 AND action = ?2 AND request_id = ?3)
          AND (?5 <= 0 OR NOT EXISTS (SELECT 1 FROM bot_rate_slots WHERE token_id = ?1 AND action = ?2 AND created_at > ?4 - ?5))
          AND (SELECT count(*) FROM bot_rate_slots WHERE token_id = ?1 AND action = ?2 AND created_at > ?4 - ?6) < ?7`,
    )
    .bind(tokenId, action, requestId, now, intervalMs, DAY_MS, perDay)
    .run();
  if ((r.meta.changes ?? 0) === 1) return "reserved";
  // 入らなかった理由を調べる（ここは判定ではなく、返すメッセージと retryAfter のため）
  const dup = await db.prepare("SELECT 1 AS x FROM bot_rate_slots WHERE token_id = ? AND action = ? AND request_id = ?").bind(tokenId, action, requestId).first();
  if (dup) return "duplicate";
  const st = await db
    .prepare("SELECT count(*) AS n, max(created_at) AS last FROM bot_rate_slots WHERE token_id = ? AND action = ? AND created_at > ?")
    .bind(tokenId, action, now - DAY_MS)
    .first<{ n: number; last: number | null }>();
  if ((st?.n ?? 0) >= perDay) throw new ToolError("rate_limited", input.dailyMessage, Math.ceil(DAY_MS / 1000));
  const last = st?.last ?? now;
  throw new ToolError("rate_limited", "続けて送るには少し待ってください", Math.max(1, Math.ceil((last + intervalMs - now) / 1000)));
}

const sendToCoo: Handler<"baton_send_to_coo"> = async ({ env, token, now }, input) => {
  const db = env.DB;
  // 同じ requestId の送り直しは制限に数えない（冪等）。届け済みなら予約もしない
  const dup = await db.prepare("SELECT id FROM thread_messages WHERE client_id = ?").bind(`bot:${token.id}:${input.requestId}`).first();
  if (!dup) {
    await reserveSlot(db, {
      tokenId: token.id,
      action: "baton_send_to_coo",
      requestId: input.requestId,
      now,
      intervalMs: LIMITS.botSendIntervalMs,
      perDay: LIMITS.botSendsPerDay,
      dailyMessage: "1 日に送れる数を超えました",
    });
  }
  let posted;
  try {
    posted = await postSecretaryMessage(env, { tokenId: token.id, requestId: input.requestId, body: input.message, projectId: input.projectId });
  } catch (err) {
    if (err instanceof ApiError && err.code === "invalid") throw new ToolError("invalid", "プロジェクトが見つかりません");
    throw err;
  }
  const note = posted.created ? "COO に届けました。返事は baton_read_coo_thread で読めます。" : "同じ requestId のメッセージは届け済みです。";
  return { summary: note, data: { messageId: posted.message.id, seq: posted.message.seq, note }, target: posted.message.id };
};

const proposeAnswer: Handler<"baton_propose_answer"> = async ({ env, token, now }, input) => {
  const db = env.DB;
  const d = await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(input.targetId).first<DecisionRow>();
  if (!d || d.status !== "open") throw new ToolError("not_found", "開いている承認・判断が見つかりません");
  // 日次の上限も送信と同じく原子的に予約する（並行した呼び出しで 50 件を超えない。D-119）
  await reserveSlot(db, {
    tokenId: token.id,
    action: "baton_propose_answer",
    requestId: newId(),
    now,
    intervalMs: 0,
    perDay: LIMITS.botProposalsPerDay,
    dailyMessage: "1 日に出せる回答案の数を超えました",
  });
  // 回答案を添えるだけ。決定はしない（CEO が許可・拒否を押すまで何も起きない。11.5）
  await db
    .prepare("UPDATE decisions SET suggestion = ?, suggestion_verdict = ?, suggestion_at = ? WHERE id = ? AND status = 'open'")
    .bind(input.proposal, input.verdict ?? null, now, d.id)
    .run();
  const updated = toDecision((await db.prepare("SELECT * FROM decisions WHERE id = ?").bind(d.id).first<DecisionRow>())!);
  await publish(env, [{ t: "decision.upserted", decision: updated }]);
  const note = "回答案を添えました。決めるのは CEO です。";
  return { summary: note, data: { ok: true, note }, target: d.id };
};

const HANDLERS: { [N in BotToolName]: Handler<N> } = {
  baton_overview: overview,
  baton_list_projects: listProjectsTool,
  baton_get_project: getProjectTool,
  baton_list_waiting: listWaiting,
  baton_get_instruction: getInstructionTool,
  baton_read_coo_thread: readCooThread,
  baton_send_to_coo: sendToCoo,
  baton_propose_answer: proposeAnswer,
};

// ───────────── 呼び出し（スコープ・レート制限・検査・監査） ─────────────

function argsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = typeof v === "string" ? clip(v, 200) : v;
  return clip(JSON.stringify(out), 400);
}

async function audit(env: Env, row: { tokenId: string; via: BotVia; action: string; target: string | null; summary: string; outcome: "ok" | "denied" | "invalid" | "rate_limited" | "error" }, now: number) {
  try {
    await env.DB.prepare("INSERT INTO bot_audit_log (id, token_id, via, action, target, summary, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), row.tokenId, row.via, row.action, row.target, row.summary, row.outcome, now)
      .run();
  } catch (err) {
    console.warn("bot audit failed", err);
  }
}

export async function callBotTool(env: Env, token: BotTokenRow, via: BotVia, name: string, rawArgs: unknown): Promise<BotCallResult> {
  const now = Date.now();
  const summary = argsSummary(rawArgs);
  if (!isBotToolName(name)) {
    await audit(env, { tokenId: token.id, via, action: clip(name, 100), target: null, summary, outcome: "invalid" }, now);
    return { ok: false, kind: "unknown_tool", message: `unknown tool: ${name}` };
  }
  const def = BOT_TOOLS[name];
  if (!botScopes(token).includes(def.scope)) {
    await audit(env, { tokenId: token.id, via, action: name, target: null, summary, outcome: "denied" }, now);
    return { ok: false, kind: "forbidden", message: "このトークンのスコープでは使えない道具です" };
  }
  const rate = await hubStub(env).botHit(token.id, now);
  if (!rate.ok) {
    await audit(env, { tokenId: token.id, via, action: name, target: null, summary, outcome: "rate_limited" }, now);
    return { ok: false, kind: "rate_limited", message: "呼び出しが多すぎます", retryAfterSec: rate.retryAfterSec };
  }
  const parsed = (def.input as z.ZodType).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    await audit(env, { tokenId: token.id, via, action: name, target: null, summary, outcome: "invalid" }, now);
    return { ok: false, kind: "invalid", message: "引数が正しくありません", details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  try {
    const handler = HANDLERS[name] as Handler<BotToolName>;
    const out = await handler({ env, token, via, now }, parsed.data as never);
    const data = (def.output as z.ZodType).parse(out.data) as Record<string, unknown>;
    await audit(env, { tokenId: token.id, via, action: name, target: out.target ?? null, summary, outcome: "ok" }, now);
    return { ok: true, summary: out.summary, data };
  } catch (err) {
    if (err instanceof ToolError) {
      await audit(env, { tokenId: token.id, via, action: name, target: null, summary, outcome: err.kind === "rate_limited" ? "rate_limited" : "invalid" }, now);
      return { ok: false, kind: err.kind, message: err.message, retryAfterSec: err.retryAfterSec };
    }
    console.error("bot tool failed", name, err);
    await audit(env, { tokenId: token.id, via, action: name, target: null, summary, outcome: "error" }, now);
    return { ok: false, kind: "error", message: "内部エラー" };
  }
}
