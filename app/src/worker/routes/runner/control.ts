// ランナーの制御: WebSocket・ハートビート・claim（v1 設計書 4.3・D-3、DESIGN-v2 5.4・12.3）
import { Hono } from "hono";
import {
  ClaimInput,
  ClaimOutput,
  HeartbeatInput,
  HeartbeatOutput,
  LIMITS,
  type ClaimOutput as ClaimOutputT,
  type InboxKind,
  type OpenInstructionState,
} from "@baton/shared";
import { getSummary, summariesFromRows, SUMMARY_SELECT } from "../../db/instructions.ts";
import { getProject, listProjects } from "../../db/projects.ts";
import {
  toAgentSession,
  toMessage,
  toRepo,
  toTask,
  toWorkspace,
  type AgentSessionRow,
  type InboxRow,
  type InstructionSummaryRow,
  type MessageRow,
  type RepoRow,
  type TaskRow,
  type ThreadRow,
  type WorkspaceRow,
} from "../../db/rows.ts";
import { parseQuota, parseRunnerStatusJson } from "../../db/runners.ts";
import { MESSAGE_SELECT } from "../../db/threads.ts";
import { hubStub, publish, publishRunnerStatus, threadEvents } from "../../hub/broadcast.ts";
import { parseObject } from "../../lib/json.ts";
import { checked, readJson } from "../../lib/validate.ts";
import { scanConversationBreaks } from "../../services/conversation.ts";
import type { AppEnv } from "../../types.ts";
import type { Env } from "../../env.ts";
import { forwardToHub } from "../ws.ts";

export const runnerControlRoutes = new Hono<AppEnv>();

runnerControlRoutes.get("/ws", (c) => forwardToHub(c, "runner", c.get("runner").id));

const ph = (ids: readonly unknown[]) => ids.map(() => "?").join(",");

runnerControlRoutes.post("/heartbeat", async (c) => {
  const input = await readJson(c, HeartbeatInput);
  const db = c.env.DB;
  const runner = c.get("runner");
  const now = Date.now();
  const prev = parseRunnerStatusJson(runner.status);
  const prevQuota = parseQuota(runner.quota);
  const wasOnline = runner.last_heartbeat_at !== null && now - runner.last_heartbeat_at <= LIMITS.runnerOnlineWindowMs;

  const status = {
    activeInstructionIds: input.activeInstructionIds,
    activeSessionIds: input.activeSessionIds,
    activeThreadIds: input.activeThreadIds,
    profiles: input.profiles,
  };
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE runners SET version = ?, tailnet_url = ?, last_heartbeat_at = ?, status = ?, quota = ?, claude_version = ?, claude_auth = ? WHERE id = ?`,
      )
      .bind(input.version, input.tailnetUrl, now, JSON.stringify(status), JSON.stringify(input.quota), input.claudeVersion, input.claudeAuth, runner.id),
  ];
  let heldIndex = -1;
  if (input.activeInstructionIds.length > 0) {
    // 握っている指示の lease を延ばす
    stmts.push(
      db
        .prepare(`UPDATE instructions SET lease_expires_at = ? WHERE id IN (${ph(input.activeInstructionIds)}) AND lease_runner_id = ? AND status NOT IN ('canceled','archived')`)
        .bind(now + LIMITS.leaseMs, ...input.activeInstructionIds, runner.id),
    );
    heldIndex = stmts.length;
    stmts.push(
      db
        .prepare(`SELECT id FROM instructions WHERE id IN (${ph(input.activeInstructionIds)}) AND lease_runner_id = ? AND status NOT IN ('canceled','archived')`)
        .bind(...input.activeInstructionIds, runner.id),
    );
  }
  if (input.activeThreadIds.length > 0) {
    stmts.push(
      db
        .prepare(`UPDATE threads SET lease_expires_at = ? WHERE id IN (${ph(input.activeThreadIds)}) AND lease_runner_id = ? AND status = 'running'`)
        .bind(now + LIMITS.leaseMs, ...input.activeThreadIds, runner.id),
    );
  }
  const results = await db.batch(stmts);
  const stillHeld = new Set(heldIndex >= 0 ? ((results[heldIndex]?.results ?? []) as { id: string }[]).map((r) => r.id) : []);
  const cancelInstructionIds = input.activeInstructionIds.filter((id) => !stillHeld.has(id));
  const interrupts = await hubStub(c.env).takeInterrupts();

  const changed =
    !wasOnline ||
    JSON.stringify(prev.activeInstructionIds) !== JSON.stringify(input.activeInstructionIds) ||
    JSON.stringify(prev.activeSessionIds) !== JSON.stringify(input.activeSessionIds) ||
    runner.version !== input.version ||
    runner.tailnet_url !== input.tailnetUrl ||
    runner.claude_version !== input.claudeVersion ||
    runner.claude_auth !== input.claudeAuth;
  if (changed) await publishRunnerStatus(c.env);
  if (JSON.stringify(prevQuota) !== JSON.stringify(input.quota)) await publish(c.env, [{ t: "quota.updated", quota: input.quota }]);
  return c.json(
    checked(c.env, HeartbeatOutput, {
      serverTime: now,
      cancelInstructionIds,
      interruptSessionIds: interrupts.sessionIds,
      interruptThreadIds: interrupts.threadIds,
      interruptRequests: interrupts.requests,
    }),
  );
});

// ───────────── claim（5.4） ─────────────

runnerControlRoutes.post("/claim", async (c) => {
  const input = await readJson(c, ClaimInput);
  const now = Date.now();
  const runnerId = c.get("runner").id;
  let out: ClaimOutputT | null = null;
  for (const kind of ["thread", "instruction", "finalize"] as const) {
    if (!input.kinds.includes(kind)) continue;
    if (kind === "thread") {
      await scanConversationBreaks(c.env, now);
      out = await claimThread(c.env, runnerId, input.activeThreadIds, now);
    } else if (kind === "instruction") {
      out = await claimInstruction(c.env, runnerId, input.activeInstructionIds, input.quotaPaused, now);
    } else {
      out = await claimFinalize(c.env, runnerId, input.activeInstructionIds, now);
    }
    if (out) break;
  }
  if (!out) return c.body(null, 204);
  return c.json(checked(c.env, ClaimOutput, out));
});

/** 取り出せるスレッド: 受信箱に起こすものがある queued（not_before と lease を見る）、または lease 切れの running */
function claimableThreadSql(t: string) {
  return `((${t}.status = 'queued' AND (${t}.not_before IS NULL OR ${t}.not_before <= ?2)
            AND (${t}.lease_expires_at IS NULL OR ${t}.lease_expires_at < ?2)
            AND EXISTS (SELECT 1 FROM thread_inbox x WHERE x.thread_id = ${t}.id AND x.status = 'pending' AND x.wakes = 1))
        OR (${t}.status = 'running' AND ${t}.lease_expires_at IS NOT NULL AND ${t}.lease_expires_at < ?2))`;
}

async function claimThread(env: Env, runnerId: string, activeIds: string[], now: number): Promise<ClaimOutputT | null> {
  const db = env.DB;
  const exclude = activeIds.length > 0 ? `AND threads.id NOT IN (${activeIds.map((_, n) => `?${n + 3}`).join(",")})` : "";
  const { results: candidates } = await db
    .prepare(`SELECT id FROM threads WHERE ${claimableThreadSql("threads")} ${exclude} ORDER BY updated_at, id LIMIT 3`)
    .bind(runnerId, now, ...activeIds)
    .all<{ id: string }>();
  let claimedId: string | null = null;
  for (const cand of candidates) {
    // 条件付きの UPDATE で 1 件だけ握る（同時に claim が来ても 1 つのランナーにだけ渡る）
    const res = await db
      .prepare(
        `UPDATE threads SET status = 'running', lease_runner_id = ?1, lease_expires_at = ?3, not_before = NULL, updated_at = ?2
          WHERE id = ?4 AND ${claimableThreadSql("threads")}`,
      )
      .bind(runnerId, now, now + LIMITS.leaseMs, cand.id)
      .run();
    if (res.meta.changes === 1) {
      claimedId = cand.id;
      break;
    }
  }
  if (!claimedId) return null;
  const thread = (await db.prepare("SELECT * FROM threads WHERE id = ?").bind(claimedId).first<ThreadRow>())!;
  const [inbox, recent, turns, openRows, repos, talking] = await db.batch([
    db.prepare("SELECT * FROM thread_inbox WHERE thread_id = ? AND status = 'pending' ORDER BY created_at, rowid").bind(thread.id),
    db.prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? AND m.status = 'complete' ORDER BY m.seq DESC LIMIT ?`).bind(thread.id, LIMITS.handoffMessages),
    db.prepare("SELECT turns FROM agent_sessions WHERE id = ?").bind(thread.current_session_id ?? ""),
    thread.kind === "leader"
      ? db
          .prepare(`${SUMMARY_SELECT} WHERE i.status IN ('queued','running','needs_decision','review') AND i.project_id = ? ORDER BY i.created_at`)
          .bind(thread.project_id ?? "")
      : db.prepare(`${SUMMARY_SELECT} WHERE i.status IN ('queued','running','needs_decision','review') ORDER BY i.created_at`),
    db.prepare("SELECT r.*, (SELECT p.id FROM projects p WHERE p.repo_path = r.path) AS project_id FROM runner_repos r ORDER BY r.name"),
    db.prepare(
      `SELECT DISTINCT t.project_id FROM threads t JOIN thread_inbox x ON x.thread_id = t.id
        WHERE t.kind = 'leader' AND x.kind = 'ceo_message' AND x.status = 'pending'`,
    ),
  ]);
  const inboxRows = (inbox?.results ?? []) as InboxRow[];
  const openSummaries = await summariesFromRows(db, (openRows?.results ?? []) as InstructionSummaryRow[]);
  const openInstructions: OpenInstructionState[] = openSummaries.map((s) => ({
    id: s.id,
    title: s.title ?? s.body.slice(0, 60),
    status: s.status,
    phase: s.phase,
    revision: s.revision,
    projectId: s.projectId,
    talkingWithCeo: s.talkingWithCeo,
  }));
  // CEO が見ている画面: 最新の CEO の発言の「〇〇 について」
  let viewing: string | null = null;
  const lastCeo = [...inboxRows].reverse().find((x) => x.kind === "ceo_message");
  const contextName = lastCeo ? parseObject(lastCeo.payload).contextProjectName : undefined;
  if (typeof contextName === "string" && contextName) viewing = `プロジェクト「${contextName}」`;
  const out: ClaimOutputT = {
    kind: "thread",
    thread: {
      id: thread.id,
      kind: thread.kind,
      projectId: thread.project_id,
      agentId: thread.agent_id,
      currentSessionId: thread.current_session_id,
      sessionTurns: ((turns?.results?.[0] as { turns: number } | undefined)?.turns ?? 0) as number,
      lastSeq: thread.last_seq,
    },
    inbox: inboxRows.map((x) => ({
      id: x.id,
      threadId: x.thread_id,
      kind: x.kind as InboxKind,
      wakes: x.wakes === 1,
      messageId: x.message_id,
      instructionId: x.instruction_id,
      payload: parseObject(x.payload),
      createdAt: x.created_at,
    })),
    context: {
      recentMessages: ((recent?.results ?? []) as MessageRow[]).reverse().map(toMessage),
      openInstructions,
      projects: await listProjects(db, { activeOnly: true }),
      repos: ((repos?.results ?? []) as RepoRow[]).map(toRepo),
      talkingProjectIds: ((talking?.results ?? []) as { project_id: string }[]).map((r) => r.project_id).filter(Boolean),
      viewing,
    },
  };
  await publish(env, await threadEvents(env, [thread.id]));
  return out;
}

/**
 * 取り出せる指示（members の段階）: lease が無いか切れていて、
 * 動かすべきタスク（枠でメンバーの起動を止めている間は除く）・再開するセッション・回答済みの判断・追加の依頼のどれかがある
 */
function claimableInstructionSql(i: string, quotaPaused: boolean) {
  const leaseFree = `(${i}.lease_runner_id IS NULL OR ${i}.lease_expires_at < ?2) AND (${i}.not_before IS NULL OR ${i}.not_before <= ?2)`;
  const pendingTask = quotaPaused ? "0" : `EXISTS (SELECT 1 FROM tasks t WHERE t.instruction_id = ${i}.id AND t.kind = 'work' AND t.status = 'pending')`;
  const resumable = `EXISTS (SELECT 1 FROM agent_sessions s WHERE s.instruction_id = ${i}.id AND s.role = 'member'
       AND (s.status IN ('pending','running','awaiting_approval','quota_wait')
            OR (s.status = 'paused' AND EXISTS (SELECT 1 FROM decisions d WHERE d.session_id = s.id AND d.status = 'answered' AND d.answered_at >= s.updated_at))))`;
  const followUp = `EXISTS (SELECT 1 FROM session_inputs si WHERE si.instruction_id = ${i}.id AND si.status = 'pending')`;
  return `(${leaseFree} AND ${i}.project_id IS NOT NULL AND (
    (${i}.status = 'running' AND ${i}.phase = 'members' AND (${pendingTask} OR ${resumable} OR ${followUp}))
    OR (${i}.status IN ('running','needs_decision','review') AND ${followUp})))`;
}

async function claimInstruction(env: Env, runnerId: string, activeIds: string[], quotaPaused: boolean, now: number): Promise<ClaimOutputT | null> {
  const db = env.DB;
  const exclude = activeIds.length > 0 ? `AND instructions.id NOT IN (${activeIds.map((_, n) => `?${n + 3}`).join(",")})` : "";
  const cond = claimableInstructionSql("instructions", quotaPaused);
  const { results: candidates } = await db
    .prepare(`SELECT id FROM instructions WHERE ${cond} ${exclude} ORDER BY created_at, id LIMIT 3`)
    .bind(runnerId, now, ...activeIds)
    .all<{ id: string }>();
  let claimedId: string | null = null;
  for (const cand of candidates) {
    const res = await db
      .prepare(
        `UPDATE instructions SET lease_runner_id = ?1, lease_expires_at = ?3, attempt = attempt + 1, not_before = NULL, updated_at = ?2
          WHERE id = ?4 AND ${cond}`,
      )
      .bind(runnerId, now, now + LIMITS.leaseMs, cand.id)
      .run();
    if (res.meta.changes === 1) {
      claimedId = cand.id;
      break;
    }
  }
  if (!claimedId) return null;
  const parts = await loadInstructionParts(db, claimedId);
  return { kind: "instruction", ...parts, tasks: parts.tasks, sessions: parts.sessions };
}

async function claimFinalize(env: Env, runnerId: string, activeIds: string[], now: number): Promise<ClaimOutputT | null> {
  const db = env.DB;
  const exclude = activeIds.length > 0 ? `AND instructions.id NOT IN (${activeIds.map((_, n) => `?${n + 4}`).join(",")})` : "";
  const cond = `instructions.status = 'done' AND instructions.finalized_at IS NULL AND instructions.status_changed_at <= ?3
    AND instructions.project_id IS NOT NULL AND (instructions.lease_runner_id IS NULL OR instructions.lease_expires_at < ?2)`;
  const { results: candidates } = await db
    .prepare(`SELECT id FROM instructions WHERE ${cond} ${exclude} ORDER BY status_changed_at, id LIMIT 3`)
    .bind(runnerId, now, now - LIMITS.finalizeDelayMs, ...activeIds)
    .all<{ id: string }>();
  for (const cand of candidates) {
    const res = await db
      .prepare(`UPDATE instructions SET lease_runner_id = ?1, lease_expires_at = ?4 WHERE id = ?5 AND ${cond}`)
      .bind(runnerId, now, now - LIMITS.finalizeDelayMs, now + LIMITS.leaseMs, cand.id)
      .run();
    if (res.meta.changes === 1) {
      const parts = await loadInstructionParts(db, cand.id);
      return { kind: "finalize", instruction: parts.instruction, workspaces: parts.workspaces, project: parts.project };
    }
  }
  return null;
}

async function loadInstructionParts(db: D1Database, id: string) {
  const row = (await db.prepare("SELECT * FROM instructions WHERE id = ?").bind(id).first<{ feedback: string | null; attempt: number; origin_thread_id: string | null; project_id: string }>())!;
  const summary = (await getSummary(db, id))!;
  const [tasks, workspaces, sessions] = await db.batch([
    db.prepare("SELECT * FROM tasks WHERE instruction_id = ? ORDER BY round, seq, created_at").bind(id),
    db.prepare("SELECT * FROM workspaces WHERE instruction_id = ? ORDER BY created_at").bind(id),
    db.prepare("SELECT * FROM agent_sessions WHERE instruction_id = ? AND role = 'member' ORDER BY created_at").bind(id),
  ]);
  return {
    instruction: { ...summary, feedback: row.feedback, attempt: row.attempt, originThreadId: row.origin_thread_id },
    tasks: ((tasks?.results ?? []) as TaskRow[]).map(toTask),
    workspaces: ((workspaces?.results ?? []) as WorkspaceRow[]).map(toWorkspace),
    sessions: ((sessions?.results ?? []) as AgentSessionRow[]).map(toAgentSession),
    project: (await getProject(db, row.project_id))!,
  };
}

