// FakeBatonApi: メモリ上の D1 もどき（設計書 8.2）。lease と状態の検査（4.3）を再現し、入力は shared の zod で検査する。
import { randomUUID } from "node:crypto";
import {
  AiChatInput,
  AppendEventsInput,
  ClaimInput,
  CreateAgentsInput,
  CreateArtifactInput,
  CreateDecisionInput,
  CreateProjectInput,
  CreateTasksInput,
  HeartbeatInput,
  ReleaseInput,
  RunnerInstructionPatch,
  TaskPatch,
  type Agent,
  type AppendEventInput,
  type Artifact,
  type ClaimOutput,
  type Decision,
  type InstructionStatus,
  type InstructionSummary,
  type ProjectWithTeam,
  type RunnerInstructionState,
  type Task,
} from "@baton/shared";
import type { BatonApi } from "../../src/api.ts";
import { ApiError, ConflictError } from "../../src/errors.ts";
import type { FakeAi } from "./fake-ai.ts";

type Opts = { signal?: AbortSignal };

export type FakeInstruction = {
  id: string;
  clientId: string;
  body: string;
  title: string | null;
  status: InstructionStatus;
  statusChangedAt: number;
  projectId: string | null;
  resultSummary: string | null;
  feedback: string | null;
  error: string | null;
  notBefore: number | null;
  attempt: number;
  leaseRunnerId: string | null;
  leaseExpiresAt: number | null;
  tokensIn: number;
  tokensOut: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type ApiCall = { method: string; instructionId: string | null; at: number };

export class FakeBatonApi implements BatonApi {
  readonly runnerId = "runner-1";
  readonly ai: FakeAi;
  now: () => number = () => Date.now();
  readonly instructions = new Map<string, FakeInstruction>();
  readonly projects: ProjectWithTeam[] = [];
  readonly tasks: Task[] = [];
  readonly events: (AppendEventInput & { instructionId: string })[] = [];
  readonly artifacts: Artifact[] = [];
  readonly decisions: Decision[] = [];
  readonly releases: { instructionId: string; input: ReleaseInput }[] = [];
  readonly calls: ApiCall[] = [];
  readonly heartbeats: HeartbeatInput[] = [];
  readonly cancelIds = new Set<string>();
  readonly coo: Agent = { id: "agent-coo", projectId: null, role: "coo", name: "COO", specialty: "全体の指揮", model: null, active: true };
  /** テスト用: 次の呼び出しで投げるエラー */
  failNext: { method: string; error: Error } | null = null;
  /** activeProjects を state に入れるか（Worker が未対応の場合の再現） */
  includeActiveProjects = true;

  constructor(ai: FakeAi) {
    this.ai = ai;
  }

  // ───────────── テストの操作 ─────────────

  addInstruction(body: string, over: Partial<FakeInstruction> = {}): string {
    const id = randomUUID();
    const t = this.now();
    this.instructions.set(id, {
      id,
      clientId: randomUUID(),
      body,
      title: null,
      status: "queued",
      statusChangedAt: t,
      projectId: null,
      resultSummary: null,
      feedback: null,
      error: null,
      notBefore: null,
      attempt: 0,
      leaseRunnerId: null,
      leaseExpiresAt: null,
      tokensIn: 0,
      tokensOut: 0,
      createdAt: t,
      updatedAt: t,
      completedAt: null,
      ...over,
    });
    return id;
  }

  inst(id: string): FakeInstruction {
    const i = this.instructions.get(id);
    if (!i) throw new Error(`no instruction ${id}`);
    return i;
  }

  /** CEO が判断に答えた（POST /api/decisions/:id/answer） */
  answerDecision(decisionId: string, answer: string): void {
    const d = this.decisions.find((x) => x.id === decisionId);
    if (!d || d.status !== "open") throw new Error("decision not open");
    d.status = "answered";
    d.answer = answer;
    d.answeredAt = this.now();
    this.setStatus(this.inst(d.instructionId), "queued");
  }

  /** CEO が取り消した */
  cancelByCeo(id: string): void {
    const i = this.inst(id);
    this.setStatus(i, "canceled");
    i.leaseRunnerId = null;
    this.cancelIds.add(id);
  }

  sendBack(id: string, comment: string): void {
    const i = this.inst(id);
    if (i.status !== "review") throw new Error("not review");
    i.feedback = comment;
    this.setStatus(i, "queued");
  }

  /** 実行中に落ちたことにする（lease を切らす） */
  expireLease(id: string): void {
    const i = this.inst(id);
    i.leaseExpiresAt = this.now() - 1;
  }

  callsAfter(t: number, instructionId?: string): ApiCall[] {
    return this.calls.filter((c) => c.at > t && (!instructionId || c.instructionId === instructionId));
  }

  tasksOf(id: string): Task[] {
    return this.tasks.filter((t) => t.instructionId === id);
  }
  eventsOf(id: string): (AppendEventInput & { instructionId: string })[] {
    return this.events.filter((e) => e.instructionId === id).sort((a, b) => a.seq - b.seq);
  }

  // ───────────── 内部 ─────────────

  private record(method: string, instructionId: string | null): void {
    this.calls.push({ method, instructionId, at: performance.now() });
    if (this.failNext && this.failNext.method === method) {
      const e = this.failNext.error;
      this.failNext = null;
      throw e;
    }
  }

  private checkSignal(opts?: Opts): void {
    if (opts?.signal?.aborted) throw opts.signal.reason;
  }

  private setStatus(i: FakeInstruction, s: InstructionStatus): void {
    i.status = s;
    i.statusChangedAt = this.now();
    i.updatedAt = this.now();
    if (s !== "running") {
      i.leaseRunnerId = null;
      i.leaseExpiresAt = null;
    }
  }

  /** 4.3: lease_runner_id 一致かつ status = 'running'。違えば 409 */
  private assertLease(instructionId: string): FakeInstruction {
    const i = this.instructions.get(instructionId);
    if (!i) throw new ApiError(404, "not_found", "not found");
    if (i.status !== "running" || i.leaseRunnerId !== this.runnerId) throw new ConflictError("この指示を握っていません");
    return i;
  }

  private summary(i: FakeInstruction): InstructionSummary {
    const ts = this.tasksOf(i.id);
    const project = this.projects.find((p) => p.id === i.projectId);
    return {
      id: i.id,
      clientId: i.clientId,
      body: i.body,
      title: i.title,
      status: i.status,
      statusChangedAt: i.statusChangedAt,
      projectId: i.projectId,
      projectName: project?.name ?? null,
      resultSummary: i.resultSummary,
      openDecisionId: this.decisions.find((d) => d.instructionId === i.id && d.status === "open")?.id ?? null,
      notBefore: i.notBefore,
      error: i.error,
      taskCounts: {
        total: ts.length,
        done: ts.filter((t) => t.status === "done").length,
        running: ts.filter((t) => t.status === "running").length,
        failed: ts.filter((t) => t.status === "failed").length,
      },
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      completedAt: i.completedAt,
    };
  }

  // ───────────── BatonApi ─────────────

  async heartbeat(input: Parameters<BatonApi["heartbeat"]>[0], opts?: Opts) {
    this.record("heartbeat", null);
    this.checkSignal(opts);
    this.heartbeats.push(HeartbeatInput.parse(input));
    for (const id of input.activeInstructionIds) {
      const i = this.instructions.get(id);
      if (i && i.leaseRunnerId === this.runnerId) i.leaseExpiresAt = this.now() + 10 * 60_000;
    }
    return { serverTime: this.now(), cancelInstructionIds: input.activeInstructionIds.filter((id) => this.cancelIds.has(id)) };
  }

  async claim(input: Parameters<BatonApi["claim"]>[0], opts?: Opts): Promise<ClaimOutput | null> {
    this.record("claim", null);
    this.checkSignal(opts);
    ClaimInput.parse(input);
    const now = this.now();
    const candidates = [...this.instructions.values()]
      .filter(
        (i) =>
          !input.activeIds.includes(i.id) &&
          ((i.status === "queued" && (i.notBefore === null || i.notBefore <= now)) ||
            (i.status === "running" && i.leaseExpiresAt !== null && i.leaseExpiresAt < now)),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const i = candidates[0];
    if (!i) return null;
    this.setStatus(i, "running");
    i.leaseRunnerId = this.runnerId;
    i.leaseExpiresAt = now + 10 * 60_000;
    i.attempt++;
    i.notBefore = null;
    const resume = this.tasksOf(i.id).length > 0 || this.eventsOf(i.id).length > 0;
    return { instruction: { ...this.summary(i), feedback: i.feedback, attempt: i.attempt }, resume };
  }

  async getState(id: string, opts?: Opts): Promise<RunnerInstructionState> {
    this.record("getState", id);
    this.checkSignal(opts);
    const i = this.assertLease(id);
    const evs = this.eventsOf(id);
    const project = this.projects.find((p) => p.id === i.projectId) ?? null;
    return {
      instruction: { ...this.summary(i), feedback: i.feedback, attempt: i.attempt },
      project: project ? structuredClone(project) : null,
      coo: this.coo,
      tasks: structuredClone(this.tasksOf(id)),
      decisions: structuredClone(this.decisions.filter((d) => d.instructionId === id)),
      routed: evs.some((e) => e.kind === "action" && (e.content as { stage?: string } | null)?.stage === "route"),
      nextEventSeq: evs.reduce((m, e) => Math.max(m, e.seq + 1), 0),
      ...(this.includeActiveProjects ? { activeProjects: structuredClone(this.projects.filter((p) => p.status === "active")) } : {}),
    };
  }

  async patchInstruction(id: string, patch: Parameters<BatonApi["patchInstruction"]>[1], opts?: Opts) {
    this.record("patchInstruction", id);
    this.checkSignal(opts);
    RunnerInstructionPatch.parse(patch);
    const i = this.assertLease(id);
    if (patch.title !== undefined) i.title = patch.title;
    if (patch.projectId !== undefined) i.projectId = patch.projectId;
    if (patch.resultSummary !== undefined) i.resultSummary = patch.resultSummary;
    if (patch.error !== undefined) i.error = patch.error;
    if (patch.status) {
      this.setStatus(i, patch.status);
    }
    i.updatedAt = this.now();
    return this.summary(i);
  }

  async release(id: string, input: Parameters<BatonApi["release"]>[1], opts?: Opts) {
    this.record("release", id);
    this.checkSignal(opts);
    ReleaseInput.parse(input);
    const i = this.assertLease(id);
    this.releases.push({ instructionId: id, input });
    i.notBefore = input.notBefore;
    if (input.error) i.error = input.error;
    this.setStatus(i, "queued");
  }

  async createProject(input: Parameters<BatonApi["createProject"]>[0], opts?: Opts) {
    this.record("createProject", input.instructionId);
    this.checkSignal(opts);
    CreateProjectInput.parse(input);
    this.assertLease(input.instructionId);
    let slug = input.slug;
    for (let n = 2; this.projects.some((p) => p.slug === slug); n++) slug = `${input.slug}-${n}`;
    const id = randomUUID();
    const mk = (role: "leader" | "member", a: { name: string; specialty: string }): Agent => ({ id: randomUUID(), projectId: id, role, name: a.name, specialty: a.specialty, model: null, active: true });
    const p: ProjectWithTeam = {
      id,
      slug,
      name: input.name,
      summary: input.summary,
      status: "active",
      agents: [mk("leader", input.leader), ...input.members.map((m) => mk("member", m))],
      updatedAt: this.now(),
    };
    this.projects.push(p);
    return structuredClone(p);
  }

  async addAgents(projectId: string, input: Parameters<BatonApi["addAgents"]>[1], opts?: Opts) {
    this.record("addAgents", input.instructionId);
    this.checkSignal(opts);
    CreateAgentsInput.parse(input);
    this.assertLease(input.instructionId);
    const p = this.projects.find((x) => x.id === projectId);
    if (!p) throw new ApiError(404, "not_found", "no project");
    const added = input.agents.map((a) => ({ id: randomUUID(), projectId, role: "member" as const, name: a.name, specialty: a.specialty, model: null, active: true }));
    p.agents.push(...added);
    return added;
  }

  async createTasks(input: Parameters<BatonApi["createTasks"]>[0], opts?: Opts) {
    this.record("createTasks", input.tasks[0]?.instructionId ?? null);
    this.checkSignal(opts);
    CreateTasksInput.parse(input);
    const out: Task[] = [];
    for (const t of input.tasks) {
      this.assertLease(t.instructionId);
      const existing = t.id ? this.tasks.find((x) => x.id === t.id) : undefined;
      if (existing) {
        out.push(structuredClone(existing));
        continue;
      }
      const task: Task = {
        id: t.id ?? randomUUID(),
        instructionId: t.instructionId,
        parentTaskId: t.parentTaskId,
        assigneeAgentId: t.assigneeAgentId,
        kind: t.kind,
        planKey: t.planKey,
        dependsOn: t.dependsOn,
        title: t.title,
        spec: t.spec,
        status: "pending",
        resultSummary: null,
        round: t.round,
        seq: t.seq,
        startedAt: null,
        finishedAt: null,
        updatedAt: this.now(),
      };
      this.tasks.push(task);
      out.push(structuredClone(task));
    }
    return out;
  }

  async patchTask(id: string, patch: Parameters<BatonApi["patchTask"]>[1], opts?: Opts) {
    const t = this.tasks.find((x) => x.id === id);
    this.record("patchTask", t?.instructionId ?? null);
    this.checkSignal(opts);
    TaskPatch.parse(patch);
    if (!t) throw new ApiError(404, "not_found", "no task");
    this.assertLease(t.instructionId);
    if (patch.status) {
      t.status = patch.status;
      if (patch.status === "running") t.startedAt = this.now();
      if (["done", "failed", "canceled"].includes(patch.status)) t.finishedAt = this.now();
    }
    if (patch.resultSummary !== undefined) t.resultSummary = patch.resultSummary;
    if (patch.assigneeAgentId !== undefined) t.assigneeAgentId = patch.assigneeAgentId;
    t.updatedAt = this.now();
    return structuredClone(t);
  }

  async appendEvents(input: Parameters<BatonApi["appendEvents"]>[0], opts?: Opts) {
    this.record("appendEvents", input.instructionId);
    this.checkSignal(opts);
    AppendEventsInput.parse(input);
    this.assertLease(input.instructionId);
    for (const e of input.events) {
      if (this.events.some((x) => x.instructionId === input.instructionId && x.seq === e.seq)) continue; // 重複 seq は無視
      this.events.push({ ...e, instructionId: input.instructionId });
    }
    return { lastSeq: this.eventsOf(input.instructionId).reduce((m, e) => Math.max(m, e.seq), -1) };
  }

  async createArtifact(input: Parameters<BatonApi["createArtifact"]>[0], opts?: Opts) {
    this.record("createArtifact", input.instructionId);
    this.checkSignal(opts);
    CreateArtifactInput.parse(input);
    const i = this.assertLease(input.instructionId);
    const same = this.artifacts.find((a) => a.instructionId === input.instructionId && a.relPath === input.relPath && a.sha256 === input.sha256);
    if (same) return same;
    const project = this.projects.find((p) => p.id === i.projectId);
    const a: Artifact = {
      id: randomUUID(),
      instructionId: input.instructionId,
      taskId: input.taskId,
      projectSlug: project?.slug ?? null,
      relPath: input.relPath,
      title: input.title,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      createdAt: this.now(),
      sha256: input.sha256,
      previewText: input.previewText,
    };
    this.artifacts.push(a);
    return a;
  }

  async createDecision(input: Parameters<BatonApi["createDecision"]>[0], opts?: Opts) {
    this.record("createDecision", input.instructionId);
    this.checkSignal(opts);
    CreateDecisionInput.parse(input);
    const i = this.assertLease(input.instructionId);
    const d: Decision = {
      id: randomUUID(),
      instructionId: input.instructionId,
      taskId: input.taskId,
      askedByAgentId: input.askedByAgentId,
      question: input.question,
      options: input.options,
      status: "open",
      answer: null,
      answeredAt: null,
      createdAt: this.now(),
    };
    this.decisions.push(d);
    this.setStatus(i, "needs_decision"); // 握りも外れる
    return d;
  }

  async aiChat(input: Parameters<BatonApi["aiChat"]>[0], opts?: Opts) {
    this.record("aiChat", input.instructionId);
    this.checkSignal(opts);
    AiChatInput.parse(input);
    const i = this.assertLease(input.instructionId);
    const out = await this.ai.respond(input, opts?.signal);
    i.tokensIn += out.usage.tokensIn;
    i.tokensOut += out.usage.tokensOut;
    return out;
  }
}
