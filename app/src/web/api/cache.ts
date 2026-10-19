// クエリキャッシュへの反映（REST の応答・WebSocket のイベント・楽観的更新で共通に使う）
import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentEvent,
  ArtifactMeta,
  Decision,
  InstructionDetail,
  InstructionSummary,
  ListEventsOutput,
  ListInstructionsOutput,
  SessionInfo,
  RunnerStatus,
  Task,
} from "@baton/shared";
import { qk } from "./keys.ts";

type Views = "active" | "archived";
const VIEWS: Views[] = ["active", "archived"];

function belongsTo(view: Views, item: InstructionSummary): boolean {
  return view === "archived" ? item.status === "archived" : item.status !== "archived";
}

/** 一覧と詳細の両方に指示を反映する。clientId が同じ楽観的な行は置き換える（重複させない） */
export function upsertInstruction(qc: QueryClient, inst: InstructionSummary, opts: { force?: boolean } = {}): void {
  for (const view of VIEWS) {
    qc.setQueryData<ListInstructionsOutput>(qk.list(view), (old) => {
      if (!old) return old;
      const existing = old.items.find((i) => i.id === inst.id);
      // 古いイベントが後から届いたときは無視する（楽観的更新は updatedAt を動かさない）
      if (!opts.force && existing && existing.updatedAt > inst.updatedAt) return old;
      const items = old.items.filter((i) => i.id !== inst.id && i.clientId !== inst.clientId);
      if (belongsTo(view, inst)) items.unshift(inst);
      return { ...old, items };
    });
  }
  qc.setQueryData<InstructionDetail>(qk.detail(inst.id), (old) => {
    if (!old) return old;
    if (!opts.force && old.instruction.updatedAt > inst.updatedAt) return old;
    return { ...old, instruction: { ...old.instruction, ...inst } };
  });
}

/** 一覧から指示を探す */
export function findInstruction(qc: QueryClient, id: string): InstructionSummary | undefined {
  for (const view of VIEWS) {
    const hit = qc.getQueryData<ListInstructionsOutput>(qk.list(view))?.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return qc.getQueryData<InstructionDetail>(qk.detail(id))?.instruction;
}

export function removeInstruction(qc: QueryClient, idOrClientId: string): void {
  for (const view of VIEWS) {
    qc.setQueryData<ListInstructionsOutput>(qk.list(view), (old) =>
      old ? { ...old, items: old.items.filter((i) => i.id !== idOrClientId && i.clientId !== idOrClientId) } : old,
    );
  }
}

// タスク数は「work タスク」で数える（進捗線は work の完了数 / 総数）
const taskStatusSeen = new Map<string, Task["status"]>();

function countsFromTasks(tasks: Task[]): InstructionSummary["taskCounts"] {
  const work = tasks.filter((t) => t.kind === "work");
  return {
    total: work.length,
    done: work.filter((t) => t.status === "done").length,
    running: work.filter((t) => t.status === "running").length,
    failed: work.filter((t) => t.status === "failed").length,
  };
}

function patchSummaryEverywhere(qc: QueryClient, id: string, patch: (s: InstructionSummary) => InstructionSummary): void {
  for (const view of VIEWS) {
    qc.setQueryData<ListInstructionsOutput>(qk.list(view), (old) =>
      old ? { ...old, items: old.items.map((i) => (i.id === id ? patch(i) : i)) } : old,
    );
  }
  qc.setQueryData<InstructionDetail>(qk.detail(id), (old) =>
    old ? { ...old, instruction: { ...old.instruction, ...patch(old.instruction) } } : old,
  );
}

export function upsertTask(qc: QueryClient, task: Task): void {
  const prev = taskStatusSeen.get(task.id);
  taskStatusSeen.set(task.id, task.status);
  const detail = qc.getQueryData<InstructionDetail>(qk.detail(task.instructionId));
  if (detail) {
    const exists = detail.tasks.some((t) => t.id === task.id);
    const tasks = exists ? detail.tasks.map((t) => (t.id === task.id ? task : t)) : [...detail.tasks, task];
    qc.setQueryData<InstructionDetail>(qk.detail(task.instructionId), { ...detail, tasks });
    const counts = countsFromTasks(tasks);
    patchSummaryEverywhere(qc, task.instructionId, (s) => ({ ...s, taskCounts: counts }));
    return;
  }
  if (task.kind !== "work") return;
  // 詳細を持っていないときは、前に見た状態との差分で数を動かす
  patchSummaryEverywhere(qc, task.instructionId, (s) => {
    const c = { ...s.taskCounts };
    const bucket = (st: Task["status"] | undefined, d: number) => {
      if (st === "done") c.done += d;
      else if (st === "running") c.running += d;
      else if (st === "failed") c.failed += d;
    };
    if (prev === undefined) {
      c.total += 1;
    } else {
      bucket(prev, -1);
    }
    bucket(task.status, +1);
    c.total = Math.max(c.total, c.done + c.running + c.failed);
    for (const k of ["done", "running", "failed"] as const) c[k] = Math.max(0, c[k]);
    return { ...s, taskCounts: c };
  });
}

export function upsertDecision(qc: QueryClient, decision: Decision): void {
  qc.setQueryData<InstructionDetail>(qk.detail(decision.instructionId), (old) => {
    if (!old) return old;
    const exists = old.decisions.some((d) => d.id === decision.id);
    const decisions = exists ? old.decisions.map((d) => (d.id === decision.id ? decision : d)) : [...old.decisions, decision];
    return { ...old, decisions };
  });
  patchSummaryEverywhere(qc, decision.instructionId, (s) => {
    if (decision.status === "open") return { ...s, openDecisionId: decision.id };
    if (s.openDecisionId === decision.id) return { ...s, openDecisionId: null };
    return s;
  });
}

export function addArtifact(qc: QueryClient, artifact: ArtifactMeta): void {
  qc.setQueryData<InstructionDetail>(qk.detail(artifact.instructionId), (old) => {
    if (!old || old.artifacts.some((a) => a.id === artifact.id)) return old;
    return { ...old, artifacts: [...old.artifacts, artifact] };
  });
}

export function appendEvent(qc: QueryClient, event: AgentEvent): void {
  qc.setQueryData<ListEventsOutput>(qk.events(event.instructionId), (old) => {
    if (!old) return old;
    if (old.items.some((e) => e.seq === event.seq)) return old;
    const items = [...old.items, event].sort((a, b) => a.seq - b.seq);
    return { items };
  });
  qc.setQueryData<InstructionDetail>(qk.detail(event.instructionId), (old) =>
    old && event.seq > old.lastEventSeq ? { ...old, lastEventSeq: event.seq } : old,
  );
}

export function setRunner(qc: QueryClient, runner: RunnerStatus): void {
  qc.setQueryData<SessionInfo>(qk.session, (old) => (old ? { ...old, runner } : old));
}
