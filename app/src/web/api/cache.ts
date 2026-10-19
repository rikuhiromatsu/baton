// クエリキャッシュへの反映（REST の応答・WebSocket のイベント・楽観的更新で共通に使う）
import type { QueryClient } from "@tanstack/react-query";
import {
  countInstructions,
  type AgentSessionSummary,
  type ArtifactMeta,
  type Decision,
  type InstructionDetail,
  type InstructionSummary,
  type ListInstructionsOutput,
  type ListMessagesOutput,
  type ListThreadsOutput,
  type ProjectCounts,
  type QuotaOutput,
  type QuotaStatus,
  type RunnerStatus,
  type SessionInfo,
  type SidebarOutput,
  type Task,
  type ThreadMessage,
  type ThreadSummary,
  type TranscriptItem,
  type TranscriptOutput,
  type Workspace,
} from "@baton/shared";
import { qk } from "./keys.ts";

type Views = "active" | "archived";
const VIEWS: Views[] = ["active", "archived"];

function belongsTo(view: Views, item: InstructionSummary): boolean {
  return view === "archived" ? item.status === "archived" : item.status !== "archived";
}

// ───────────── 指示 ─────────────

/** 一覧と詳細の両方に指示を反映する */
export function upsertInstruction(qc: QueryClient, inst: InstructionSummary, opts: { force?: boolean } = {}): void {
  for (const view of VIEWS) {
    qc.setQueryData<ListInstructionsOutput>(qk.list(view), (old) => {
      if (!old) return old;
      const existing = old.items.find((i) => i.id === inst.id);
      // 古いイベントが後から届いたときは無視する（楽観的更新は updatedAt を動かさない）
      if (!opts.force && existing && existing.updatedAt > inst.updatedAt) return old;
      const items = old.items.filter((i) => i.id !== inst.id);
      if (belongsTo(view, inst)) items.unshift(inst);
      return { ...old, items };
    });
  }
  qc.setQueryData<InstructionDetail>(qk.detail(inst.id), (old) => {
    if (!old) return old;
    if (!opts.force && old.instruction.updatedAt > inst.updatedAt) return old;
    return { ...old, instruction: { ...old.instruction, ...inst } };
  });
  patchSidebarCountsFromList(qc, inst.projectId);
}

/** 一覧から指示を探す */
export function findInstruction(qc: QueryClient, id: string): InstructionSummary | undefined {
  for (const view of VIEWS) {
    const hit = qc.getQueryData<ListInstructionsOutput>(qk.list(view))?.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return qc.getQueryData<InstructionDetail>(qk.detail(id))?.instruction;
}

export function removeInstruction(qc: QueryClient, id: string): void {
  for (const view of VIEWS) {
    qc.setQueryData<ListInstructionsOutput>(qk.list(view), (old) => (old ? { ...old, items: old.items.filter((i) => i.id !== id) } : old));
  }
}

function patchSummaryEverywhere(qc: QueryClient, id: string, patch: (s: InstructionSummary) => InstructionSummary): void {
  for (const view of VIEWS) {
    qc.setQueryData<ListInstructionsOutput>(qk.list(view), (old) =>
      old ? { ...old, items: old.items.map((i) => (i.id === id ? patch(i) : i)) } : old,
    );
  }
  qc.setQueryData<InstructionDetail>(qk.detail(id), (old) => (old ? { ...old, instruction: { ...old.instruction, ...patch(old.instruction) } } : old));
}

/** 一覧で持っている指示から、そのプロジェクトのサイドパネルの件数を出し直す（project.counts を待たずに動かす） */
function patchSidebarCountsFromList(qc: QueryClient, projectId: string | null): void {
  if (!projectId) return;
  const list = qc.getQueryData<ListInstructionsOutput>(qk.list("active"));
  if (!list) return;
  const counts = countInstructions(
    list.items.filter((i) => i.projectId === projectId),
    Date.now(),
  );
  setProjectCounts(qc, projectId, counts);
}

export function setProjectCounts(qc: QueryClient, projectId: string, counts: ProjectCounts): void {
  qc.setQueryData<SidebarOutput>(qk.sidebar, (old) =>
    old
      ? {
          ...old,
          items: old.items.map((it) =>
            it.project.id === projectId
              ? { ...it, counts, inProgress: counts.running + counts.queued + counts.needsDecision + counts.review + counts.failed > 0 }
              : it,
          ),
        }
      : old,
  );
}

export function upsertTask(qc: QueryClient, task: Task): void {
  qc.setQueryData<InstructionDetail>(qk.detail(task.instructionId), (old) => {
    if (!old) return old;
    const exists = old.tasks.some((t) => t.id === task.id);
    const tasks = exists ? old.tasks.map((t) => (t.id === task.id ? task : t)) : [...old.tasks, task];
    return { ...old, tasks };
  });
  const detail = qc.getQueryData<InstructionDetail>(qk.detail(task.instructionId));
  if (detail) {
    const work = detail.tasks.filter((t) => t.kind === "work");
    const counts = {
      total: work.length,
      done: work.filter((t) => t.status === "done").length,
      running: work.filter((t) => t.status === "running").length,
      failed: work.filter((t) => t.status === "failed").length,
    };
    patchSummaryEverywhere(qc, task.instructionId, (s) => ({ ...s, taskCounts: counts }));
  }
}

export function upsertDecision(qc: QueryClient, decision: Decision): void {
  qc.setQueryData<InstructionDetail>(qk.detail(decision.instructionId), (old) => {
    if (!old) return old;
    const exists = old.decisions.some((d) => d.id === decision.id);
    const decisions = exists ? old.decisions.map((d) => (d.id === decision.id ? decision : d)) : [...old.decisions, decision];
    const openDecisions = decisions.filter((d) => d.status === "open");
    return { ...old, decisions, openDecisions };
  });
  patchSummaryEverywhere(qc, decision.instructionId, (s) => {
    // 正確な数は続く instruction.upserted が持ってくる。ここではまとまり（判断待ち）へ先に動かすだけ
    if (decision.status === "open") return { ...s, openDecisionId: decision.id, openDecisionCount: Math.max(1, s.openDecisionCount) };
    if (s.openDecisionId === decision.id) return { ...s, openDecisionId: null, openDecisionCount: Math.max(0, s.openDecisionCount - 1) };
    return s;
  });
}

export function addArtifact(qc: QueryClient, artifact: ArtifactMeta): void {
  qc.setQueryData<InstructionDetail>(qk.detail(artifact.instructionId), (old) => {
    if (!old || old.artifacts.some((a) => a.id === artifact.id)) return old;
    return { ...old, artifacts: [...old.artifacts, artifact] };
  });
}

export function upsertSession(qc: QueryClient, session: AgentSessionSummary): void {
  if (!session.instructionId) return;
  qc.setQueryData<InstructionDetail>(qk.detail(session.instructionId), (old) => {
    if (!old) return old;
    const exists = old.sessions.some((x) => x.id === session.id);
    const sessions = exists ? old.sessions.map((x) => (x.id === session.id ? session : x)) : [...old.sessions, session];
    return { ...old, sessions };
  });
}

export function upsertWorkspace(qc: QueryClient, ws: Workspace): void {
  qc.setQueryData<InstructionDetail>(qk.detail(ws.instructionId), (old) => {
    if (!old) return old;
    const exists = old.workspaces.some((x) => x.id === ws.id);
    const workspaces = exists ? old.workspaces.map((x) => (x.id === ws.id ? ws : x)) : [...old.workspaces, ws];
    return { ...old, workspaces };
  });
}

// ───────────── 会話 ─────────────

/** 発言をスレッドの一覧に入れる（seq の順。同じ ID は置き換える） */
export function mergeMessages(old: readonly ThreadMessage[], incoming: readonly ThreadMessage[]): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const m of old) byId.set(m.id, m);
  for (const m of incoming) {
    const cur = byId.get(m.id);
    // 古い版で新しい版を上書きしない（WebSocket の本文は 2,000 文字で切られることがある）
    if (cur && cur.updatedAt > m.updatedAt) continue;
    if (cur && cur.status === "complete" && m.status === "streaming") continue;
    byId.set(m.id, cur && m.body.length < cur.body.length && cur.updatedAt === m.updatedAt ? { ...m, body: cur.body } : m);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
}

export function upsertMessage(qc: QueryClient, message: ThreadMessage): void {
  qc.setQueryData<ListMessagesOutput>(qk.messages(message.threadId), (old) =>
    old ? { ...old, items: mergeMessages(old.items, [message]) } : old,
  );
}

export function removeMessage(qc: QueryClient, threadId: string, messageId: string): void {
  qc.setQueryData<ListMessagesOutput>(qk.messages(threadId), (old) => (old ? { ...old, items: old.items.filter((m) => m.id !== messageId) } : old));
}

export function findThread(qc: QueryClient, threadId: string): ThreadSummary | undefined {
  const fromList = qc.getQueryData<ListThreadsOutput>(qk.threads)?.items.find((t) => t.id === threadId);
  if (fromList) return fromList;
  return qc.getQueryData<SidebarOutput>(qk.sidebar)?.items.find((i) => i.leaderThread.id === threadId)?.leaderThread;
}

export function upsertThread(qc: QueryClient, thread: ThreadSummary): void {
  qc.setQueryData<ListThreadsOutput>(qk.threads, (old) => {
    if (!old) return old;
    const exists = old.items.some((t) => t.id === thread.id);
    return { ...old, items: exists ? old.items.map((t) => (t.id === thread.id ? thread : t)) : [...old.items, thread] };
  });
  qc.setQueryData<SidebarOutput>(qk.sidebar, (old) =>
    old ? { ...old, items: old.items.map((it) => (it.leaderThread.id === thread.id ? { ...it, leaderThread: thread } : it)) } : old,
  );
}

export function patchThread(qc: QueryClient, threadId: string, patch: (t: ThreadSummary) => ThreadSummary): void {
  const cur = findThread(qc, threadId);
  if (cur) upsertThread(qc, patch(cur));
}

// ───────────── トランスクリプト ─────────────

export function mergeTranscript(old: readonly TranscriptItem[], incoming: readonly TranscriptItem[]): TranscriptItem[] {
  const bySeq = new Map<number, TranscriptItem>();
  for (const it of old) bySeq.set(it.seq, it);
  for (const it of incoming) bySeq.set(it.seq, it);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** transcript.appended を、その指示・セッションのキャッシュに足す（instructionId で絞ったものと絞らないもの） */
export function appendTranscript(qc: QueryClient, items: readonly TranscriptItem[]): void {
  const bySession = new Map<string, TranscriptItem[]>();
  for (const it of items) {
    const list = bySession.get(it.sessionId) ?? [];
    list.push(it);
    bySession.set(it.sessionId, list);
  }
  for (const [sessionId, list] of bySession) {
    for (const q of qc.getQueryCache().findAll({ queryKey: qk.transcriptsOf(sessionId) })) {
      const filter = (q.queryKey[2] as string) || null;
      const relevant = filter ? list.filter((it) => it.instructionId === filter) : list;
      if (relevant.length === 0) continue;
      qc.setQueryData<TranscriptOutput>(q.queryKey, (old) => (old ? { ...old, items: mergeTranscript(old.items, relevant) } : old));
    }
  }
}

// ───────────── その他 ─────────────

export function setRunner(qc: QueryClient, runner: RunnerStatus): void {
  qc.setQueryData<SessionInfo>(qk.session, (old) => (old ? { ...old, runner } : old));
}

export function setQuota(qc: QueryClient, quota: QuotaStatus): void {
  qc.setQueryData<QuotaOutput>(qk.quota, (old) => ({ estimatedCostTodayUsd: old?.estimatedCostTodayUsd ?? 0, ...quota }));
}
