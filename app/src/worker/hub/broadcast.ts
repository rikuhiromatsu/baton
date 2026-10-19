// Worker から Hub（DO 1 個）へイベントを渡す（v1 設計書 4.5、DESIGN-v2 12.5）。
// 配信の失敗は API の結果に影響させない（正本は D1。クライアントは hello で取り直す）。
import {
  LIMITS,
  STATUS_LABELS,
  UI_TEXT_V2,
  type RunnerServerEvent,
  type ServerEvent,
  type ThreadMessage,
} from "@baton/shared";
import type { Env } from "../env.ts";
import { getSummary } from "../db/instructions.ts";
import { projectCounts } from "../db/org.ts";
import { getProject } from "../db/projects.ts";
import { getMessage, getThread, getThreadSummary, primaryUserId } from "../db/threads.ts";
import { clip } from "../lib/json.ts";
import type { PushCandidate } from "../push/send.ts";

export function hubStub(env: Env) {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

export async function publish(env: Env, events: ServerEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await hubStub(env).publish(events);
  } catch (err) {
    console.warn("hub publish failed", err);
  }
}

export async function notifyRunners(env: Env, events: RunnerServerEvent[], runnerId?: string): Promise<void> {
  if (events.length === 0) return;
  try {
    await hubStub(env).notifyRunners(events, runnerId);
  } catch (err) {
    console.warn("hub notify failed", err);
  }
}

export async function publishRunnerStatus(env: Env): Promise<void> {
  try {
    await hubStub(env).publishRunnerStatus();
  } catch (err) {
    console.warn("hub runner status failed", err);
  }
}

export async function queuePush(env: Env, candidate: PushCandidate): Promise<void> {
  try {
    await hubStub(env).pushCandidate(candidate);
  } catch (err) {
    console.warn("hub push failed", err);
  }
}

// ───────────── イベントの組み立て ─────────────

/** message.upserted（本文は 2,000 文字まで。全文は REST） */
export function messageEvent(message: ThreadMessage): ServerEvent {
  const truncated = message.body.length > LIMITS.broadcastMaxChars;
  return { t: "message.upserted", message: truncated ? { ...message, body: clip(message.body, LIMITS.broadcastMaxChars) } : message, bodyTruncated: truncated };
}

/** thread.updated（未読は個人用の最初の利用者で数える） */
export async function threadEvents(env: Env, threadIds: (string | null | undefined)[]): Promise<ServerEvent[]> {
  const userId = await primaryUserId(env.DB);
  const out: ServerEvent[] = [];
  for (const id of new Set(threadIds.filter((x): x is string => !!x))) {
    const thread = await getThreadSummary(env.DB, id, userId);
    if (thread) out.push({ t: "thread.updated", thread });
  }
  return out;
}

/** instruction.upserted と、そのプロジェクトの project.counts */
export async function instructionEvents(env: Env, ids: (string | null | undefined)[]): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  const projects = new Set<string>();
  for (const id of new Set(ids.filter((x): x is string => !!x))) {
    const instruction = await getSummary(env.DB, id);
    if (!instruction) continue;
    out.push({ t: "instruction.upserted", instruction });
    if (instruction.projectId) projects.add(instruction.projectId);
  }
  out.push(...(await projectCountEvents(env, [...projects])));
  return out;
}

export async function projectCountEvents(env: Env, projectIds: (string | null | undefined)[]): Promise<ServerEvent[]> {
  const now = Date.now();
  const out: ServerEvent[] = [];
  for (const id of new Set(projectIds.filter((x): x is string => !!x))) {
    out.push({ t: "project.counts", projectId: id, counts: await projectCounts(env.DB, id, now) });
  }
  return out;
}

export async function projectEvents(env: Env, projectId: string): Promise<ServerEvent[]> {
  const project = await getProject(env.DB, projectId);
  if (!project) return [];
  return [{ t: "project.upserted", project }, ...(await projectCountEvents(env, [projectId]))];
}

/** 未読・通知の対象になる発言か（4.8。COO・リーダーの chat・report・project_proposal で notify=1） */
export function isNotifiable(m: Pick<ThreadMessage, "authorKind" | "kind" | "notify" | "status">): boolean {
  return m.notify && m.status === "complete" && (m.authorKind === "coo" || m.authorKind === "leader") && ["chat", "report", "project_proposal"].includes(m.kind);
}

/** 発言を配り、完成した notify=1 の発言なら通知の候補にする */
export async function afterMessages(env: Env, messageIds: string[], opts: { push?: boolean } = {}): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  for (const id of messageIds) {
    const m = await getMessage(env.DB, id);
    if (m) messages.push(m);
  }
  const events: ServerEvent[] = messages.map(messageEvent);
  events.push(...(await threadEvents(env, messages.map((m) => m.threadId))));
  await publish(env, events);
  if (opts.push !== false) {
    for (const m of messages) if (isNotifiable(m)) await queuePush(env, await messagePushCandidate(env, m));
  }
  return messages;
}

export async function messagePushCandidate(env: Env, m: ThreadMessage): Promise<PushCandidate> {
  const thread = await getThread(env.DB, m.threadId);
  let title: string = UI_TEXT_V2.roles.coo;
  let url = "/";
  if (thread?.kind === "leader" && thread.project_id) {
    const project = await getProject(env.DB, thread.project_id);
    title = project ? `${UI_TEXT_V2.roles.leader} · ${project.name}` : UI_TEXT_V2.roles.leader;
    url = `/p/${thread.project_id}/leader`;
  }
  const body = m.kind === "project_proposal" && !m.body.trim() ? UI_TEXT_V2.proposal.title : m.body;
  return { threadId: m.threadId, seq: m.seq, title, body, url, tag: m.threadId, urgent: false, at: m.updatedAt };
}

/** 承認待ち・判断待ちの通知（すぐ送る。10.1） */
export function decisionPushCandidate(d: { id: string; kind: string; question: string; instructionId: string; sessionId: string | null; createdAt: number }): PushCandidate {
  const title = d.kind === "approval" ? UI_TEXT_V2.sidebar.approvals : STATUS_LABELS.needs_decision;
  const url = `/i/${d.instructionId}${d.sessionId ? `?s=${encodeURIComponent(d.sessionId)}` : ""}`;
  return { threadId: null, seq: null, title, body: d.question, url, tag: `decision-${d.id}`, urgent: true, at: d.createdAt };
}
