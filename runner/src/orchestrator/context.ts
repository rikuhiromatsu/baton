// 1 件の指示を処理する間の状態（メモリ上。正本は D1。判断待ちや停止で捨てて、再開時は state から組み立て直す）。
import { randomUUID } from "node:crypto";
import { LIMITS } from "@baton/shared";
import type {
  Agent,
  AppendEventInput,
  ClaimedInstruction,
  CreateTaskInput,
  Decision,
  ProjectWithTeam,
  RunnerInstructionState,
  Task,
  TaskPatch,
} from "@baton/shared";
import type { BatonApi } from "../api.ts";
import { workspaceDir, type RunnerConfig, type RunnerLimits } from "../config.ts";
import { StageFailedError } from "../errors.ts";
import type { LiveLog, Logger } from "../log.ts";
import type { Semaphore } from "../sync.ts";
import { FsTools, WriteCounters } from "../tools/fs.ts";
import type { LookupFn } from "../tools/net-guard.ts";
import type { Transport } from "../tools/web-fetch.ts";
import { Budget } from "./budget.ts";

/** /status に出す直近の AI エラーなど、ランナー全体で共有する値 */
export type RunnerStats = {
  lastAiError: { at: number; instructionId: string; message: string } | null;
};

export type RunnerDeps = {
  api: BatonApi;
  config: RunnerConfig;
  /** ランナー全体の AI 同時呼び出し（5.6: 4） */
  aiSemaphore: Semaphore;
  log: Logger;
  liveLog: LiveLog;
  stats: RunnerStats;
  now?: () => number;
  /** web_fetch の名前解決と接続（テストで差し替える） */
  lookup?: LookupFn;
  transport?: Transport;
};

type EventDraft = Omit<AppendEventInput, "seq">;

/**
 * 実行ログを Worker に送る。seq は state.nextEventSeq から続け、まとめて送る（重複 seq は Worker が無視する）。
 * 同時に、tailnet の生ログ（LiveLog）には切り詰めずに流す。
 */
export class EventSink {
  private readonly api: BatonApi;
  private readonly instructionId: string;
  private readonly liveLog: LiveLog;
  private readonly maxChars: number;
  private readonly maxPerAppend: number;
  private readonly signal: AbortSignal;
  private nextSeq: number;
  private queue: { ev: AppendEventInput; resolve: () => void; reject: (e: unknown) => void }[] = [];
  private pumping = false;

  constructor(opts: { api: BatonApi; instructionId: string; startSeq: number; liveLog: LiveLog; maxChars: number; maxPerAppend: number; signal: AbortSignal }) {
    this.api = opts.api;
    this.instructionId = opts.instructionId;
    this.nextSeq = opts.startSeq;
    this.liveLog = opts.liveLog;
    this.maxChars = opts.maxChars;
    this.maxPerAppend = opts.maxPerAppend;
    this.signal = opts.signal;
  }

  get seq(): number {
    return this.nextSeq;
  }

  emit(draft: EventDraft): Promise<void> {
    this.liveLog.append(this.instructionId, draft.kind, { taskId: draft.taskId, agentId: draft.agentId, content: draft.content, model: draft.model ?? null });
    const ev: AppendEventInput = { ...draft, seq: this.nextSeq++, content: clipContent(draft.content, this.maxChars) };
    return new Promise((resolve, reject) => {
      this.queue.push({ ev, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.maxPerAppend);
        try {
          await this.api.appendEvents({ instructionId: this.instructionId, events: batch.map((b) => b.ev) }, { signal: this.signal });
          for (const b of batch) b.resolve();
        } catch (err) {
          for (const b of batch) b.reject(err);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

/** D1 に置く content を maxChars 以内にする（生ログは LiveLog 側に全文がある） */
export function clipContent(content: unknown, maxChars: number): unknown {
  let s: string;
  try {
    s = JSON.stringify(content) ?? "null";
  } catch {
    return { text: String(content).slice(0, maxChars) };
  }
  if (s.length <= maxChars) return content;
  return { truncated: true, originalChars: s.length, preview: s.slice(0, Math.max(0, maxChars - 200)) };
}

export class RunContext {
  readonly deps: RunnerDeps;
  readonly api: BatonApi;
  readonly config: RunnerConfig;
  readonly limits: RunnerLimits;
  readonly log: Logger;
  readonly signal: AbortSignal;
  readonly instruction: ClaimedInstruction;
  readonly coo: Agent;
  readonly events: EventSink;
  readonly budget: Budget;
  readonly writeCounters = new WriteCounters();
  readonly now: () => number;
  project: ProjectWithTeam | null;
  activeProjects: ProjectWithTeam[];
  tasks: Task[];
  decisions: Decision[];
  webFetchCount = 0;
  private taskSeq: number;

  constructor(deps: RunnerDeps, state: RunnerInstructionState, signal: AbortSignal) {
    this.deps = deps;
    this.api = deps.api;
    this.config = deps.config;
    this.limits = deps.config.limits;
    this.log = deps.log;
    this.signal = signal;
    this.now = deps.now ?? Date.now;
    this.instruction = state.instruction;
    this.coo = state.coo;
    this.project = state.project;
    this.activeProjects = state.activeProjects ?? (state.project ? [state.project] : []);
    this.tasks = [...state.tasks];
    this.decisions = [...state.decisions];
    this.taskSeq = state.tasks.reduce((m, t) => Math.max(m, t.seq + 1), 0);
    this.budget = new Budget(this.limits, this.now);
    this.events = new EventSink({
      api: deps.api,
      instructionId: state.instruction.id,
      startSeq: state.nextEventSeq,
      liveLog: deps.liveLog,
      maxChars: this.limits.eventContentMaxChars,
      maxPerAppend: this.limits.eventsPerAppend,
      signal,
    });
  }

  get id(): string {
    return this.instruction.id;
  }

  throwIfStopped(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }

  /** 判断をあと何回作れるか（1 指示 3 回まで。回答済み・未回答・取消を含めて数える） */
  decisionsLeft(): number {
    return Math.max(0, this.limits.decisionsPerInstruction - this.decisions.length);
  }

  nextTaskSeq(): number {
    return this.taskSeq++;
  }

  newTaskInput(t: Omit<CreateTaskInput, "id" | "instructionId" | "seq">): CreateTaskInput {
    return { id: randomUUID(), instructionId: this.id, seq: this.nextTaskSeq(), ...t };
  }

  upsertTask(task: Task): Task {
    const i = this.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.tasks[i] = task;
    else this.tasks.push(task);
    return task;
  }

  async createTasks(inputs: CreateTaskInput[], signal: AbortSignal = this.signal): Promise<Task[]> {
    const out: Task[] = [];
    for (let i = 0; i < inputs.length; i += LIMITS.tasksPerCreate) {
      const created = await this.api.createTasks({ tasks: inputs.slice(i, i + LIMITS.tasksPerCreate) }, { signal });
      for (const t of created) out.push(this.upsertTask(t));
    }
    return out;
  }

  async patchTask(taskId: string, patch: TaskPatch, signal: AbortSignal = this.signal): Promise<Task> {
    return this.upsertTask(await this.api.patchTask(taskId, patch, { signal }));
  }

  leader(): Agent {
    const leader = this.project?.agents.find((a) => a.role === "leader" && a.active) ?? this.project?.agents.find((a) => a.role === "leader");
    if (!leader) throw new StageFailedError("プロジェクトにリーダーがいません");
    return leader;
  }

  members(): Agent[] {
    return this.project?.agents.filter((a) => a.role === "member" && a.active) ?? [];
  }

  workspace(): string {
    if (!this.project) throw new StageFailedError("プロジェクトが決まっていません");
    return workspaceDir(this.config, this.project.slug);
  }

  fsTools(): FsTools {
    return new FsTools({ root: this.workspace(), limits: this.limits, counters: this.writeCounters, now: this.now });
  }

  planTask(round: number): Task | undefined {
    return this.tasks.find((t) => t.kind === "plan" && t.round === round);
  }

  reviewTask(round: number): Task | undefined {
    return this.tasks.find((t) => t.kind === "review" && t.round === round);
  }

  workTasks(round?: number): Task[] {
    return this.tasks
      .filter((t) => t.kind === "work" && (round === undefined || t.round === round))
      .sort((a, b) => a.round - b.round || a.seq - b.seq);
  }
}
