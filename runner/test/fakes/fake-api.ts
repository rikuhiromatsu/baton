// テスト用の Worker の代わり（メモリの中だけ）。ランナーが使う 12.3 の API を、設計書の振る舞いの範囲で再現する。
import { randomUUID } from "node:crypto";
import {
  COO_THREAD_ID,
  canReopen,
  canSystemTransition,
  type AgentSessionSummary,
  type AppendTranscriptInput,
  type AppendTranscriptItemInput,
  type Artifact,
  type ClaimInput,
  type ClaimOutput,
  type CreateApprovalInput,
  type CreateArtifactInput,
  type CreateDecisionInput,
  type CreateSessionInput,
  type CreateTasksInput,
  type CreateWorkspaceInput,
  type Decision,
  type FinalizedInput,
  type HeartbeatInput,
  type InboxItem,
  type InstructionReleaseInput,
  type InstructionSummary,
  type ProjectProposal,
  type ProjectWithTeam,
  type PutReposInput,
  type RepoCandidate,
  type RunnerCreateInstructionInput,
  type RunnerCreateProjectInput,
  type RunnerCreateProposalInput,
  type RunnerInboxInput,
  type RunnerInstructionPatch,
  type RunnerPatchMessageInput,
  type RunnerPostMessageInput,
  type SessionInput,
  type SessionPatch,
  type StreamInput,
  type Task,
  type TaskPatch,
  type ThreadMessage,
  type ThreadReleaseInput,
  type TurnDoneInput,
  type Workspace,
  type WorkspacePatch,
} from "@baton/shared";
import type { BatonApi } from "../../src/api.ts";
import { ConflictError, StaleRevisionError } from "../../src/errors.ts";

type Thread = {
  id: string;
  kind: "coo" | "leader";
  projectId: string | null;
  agentId: string | null;
  currentSessionId: string | null;
  sessionTurns: number;
  leased: boolean;
  notBefore: number | null;
  awaitingReply: boolean;
};

type Instr = InstructionSummary & { leased: boolean; finalizedAt: number | null; approvedAt: number | null; originThreadId: string | null };

export class FakeBatonApi implements BatonApi {
  threads = new Map<string, Thread>();
  messages = new Map<string, ThreadMessage[]>();
  inbox: (InboxItem & { consumed: boolean })[] = [];
  projects = new Map<string, ProjectWithTeam>();
  proposals: ProjectProposal[] = [];
  instructions = new Map<string, Instr>();
  tasks = new Map<string, Task>();
  sessions = new Map<string, AgentSessionSummary>();
  transcript: AppendTranscriptItemInput[] = [];
  streams: (StreamInput & { threadId: string })[] = [];
  decisions = new Map<string, Decision>();
  inputs: SessionInput[] = [];
  workspaces = new Map<string, Workspace & { diffPatch?: string | null }>();
  artifacts: CreateArtifactInput[] = [];
  repos: RepoCandidate[] = [];
  heartbeats: HeartbeatInput[] = [];
  releases: { kind: "thread" | "instruction"; id: string; reason: string; notBefore: number | null }[] = [];
  finalizedLog: { id: string; input: FinalizedInput }[] = [];
  turnDones: (TurnDoneInput & { threadId: string })[] = [];
  claims: ClaimInput[] = [];
  cancelIds: string[] = [];
  interruptSessionIds: string[] = [];
  interruptThreadIds: string[] = [];
  private order = 0;
  /** CEO がリーダーと話し中のプロジェクト（テストで直接入れる） */
  talking = new Set<string>();

  constructor() {
    this.threads.set(COO_THREAD_ID, { id: COO_THREAD_ID, kind: "coo", projectId: null, agentId: "agent-coo", currentSessionId: null, sessionTurns: 0, leased: false, notBefore: null, awaitingReply: false });
    this.messages.set(COO_THREAD_ID, []);
  }

  private now(): number {
    return Date.now();
  }

  // ───────────── テストの操作（CEO と Worker） ─────────────

  ceoSays(threadId: string, body: string, extra: { sendBack?: boolean; instructionId?: string | null } = {}): ThreadMessage {
    const m = this.addMessage(threadId, { authorKind: "ceo", authorAgentId: null, kind: "chat", body, instructionId: extra.instructionId ?? null, sessionId: null, ref: {}, status: "complete", notify: false });
    this.addInbox(threadId, { kind: "ceo_message", wakes: true, messageId: m.id, instructionId: extra.instructionId ?? null, payload: { body, ...(extra.sendBack ? { sendBack: true } : {}) } });
    return m;
  }

  secretarySays(body: string): void {
    const m = this.addMessage(COO_THREAD_ID, { authorKind: "secretary", authorAgentId: null, kind: "chat", body, instructionId: null, sessionId: null, ref: {}, status: "complete", notify: false });
    this.addInbox(COO_THREAD_ID, { kind: "secretary_message", wakes: true, messageId: m.id, instructionId: null, payload: { body } });
  }

  /** 承認（右フリック）。確定は claim の finalize で */
  approve(instructionId: string): void {
    const i = this.instructions.get(instructionId)!;
    i.status = "done";
    i.approvedAt = this.now();
  }

  answerDecision(id: string, verdict: "allow" | "deny" | null, answer: string | null = null): void {
    const d = this.decisions.get(id)!;
    d.status = "answered";
    d.verdict = verdict;
    d.answer = answer;
    d.answeredAt = this.now();
    const i = this.instructions.get(d.instructionId);
    if (i && i.status === "needs_decision") i.status = "running";
  }

  addSessionInput(sessionId: string, body: string): SessionInput {
    const s = this.sessions.get(sessionId)!;
    const input: SessionInput = { id: randomUUID(), clientId: randomUUID(), sessionId, instructionId: s.instructionId ?? "", body, status: "pending", createdAt: this.now(), deliveredAt: null };
    this.inputs.push(input);
    return input;
  }

  addProject(p: Partial<ProjectWithTeam> & { slug: string; name: string }, team: { leader?: string; members: { name: string; profile: string }[] } = { members: [{ name: "エンジニア", profile: "engineer" }] }): ProjectWithTeam {
    const id = p.id ?? randomUUID();
    const project: ProjectWithTeam = {
      id,
      slug: p.slug,
      name: p.name,
      summary: p.summary ?? "",
      goal: p.goal ?? "テストの目的",
      status: "active",
      workspaceKind: p.workspaceKind ?? "baton",
      repoPath: p.repoPath ?? null,
      repoName: p.repoName ?? null,
      baseBranch: p.baseBranch ?? null,
      agents: [
        { id: `${id}-leader`, projectId: id, role: "leader", name: team.leader ?? "リーダー", specialty: "取りまとめ", model: null, profile: "leader", active: true },
        ...team.members.map((m, i) => ({ id: `${id}-m${i}`, projectId: id, role: "member" as const, name: m.name, specialty: m.name, model: null, profile: m.profile, active: true })),
      ],
      updatedAt: this.now(),
    };
    this.projects.set(id, project);
    const tid = `thread-${id}`;
    this.threads.set(tid, { id: tid, kind: "leader", projectId: id, agentId: `${id}-leader`, currentSessionId: null, sessionTurns: 0, leased: false, notBefore: null, awaitingReply: false });
    this.messages.set(tid, []);
    return project;
  }

  messagesOf(threadId: string): ThreadMessage[] {
    return this.messages.get(threadId) ?? [];
  }
  /** エージェント・システムの完成した発言 */
  agentMessages(threadId: string): ThreadMessage[] {
    return this.messagesOf(threadId).filter((m) => m.authorKind !== "ceo" && m.authorKind !== "secretary" && m.status === "complete");
  }
  pendingInbox(threadId: string) {
    return this.inbox.filter((i) => i.threadId === threadId && !i.consumed);
  }

  private addMessage(threadId: string, m: Omit<ThreadMessage, "id" | "threadId" | "seq" | "createdAt" | "updatedAt" | "reaction" | "clientId" | "authorName"> & { id?: string }): ThreadMessage {
    const list = this.messages.get(threadId) ?? [];
    const msg: ThreadMessage = { reaction: null, clientId: null, authorName: null, ...m, id: m.id ?? randomUUID(), threadId, seq: list.length + 1, createdAt: this.now(), updatedAt: this.now() };
    list.push(msg);
    this.messages.set(threadId, list);
    return msg;
  }

  private addInbox(threadId: string, input: RunnerInboxInput): void {
    this.inbox.push({
      id: randomUUID(),
      threadId,
      kind: input.kind,
      wakes: input.wakes,
      messageId: input.messageId ?? null,
      instructionId: input.instructionId ?? null,
      payload: input.payload ?? {},
      createdAt: this.now() * 1000 + this.order++,
      consumed: false,
    });
  }

  private summary(i: Instr): InstructionSummary {
    const { leased: _l, finalizedAt: _f, approvedAt: _a, originThreadId: _o, ...rest } = i;
    return { ...rest };
  }

  instr(id: string): Instr {
    return this.instructions.get(id)!;
  }

  // ───────────── BatonApi ─────────────

  async heartbeat(input: HeartbeatInput) {
    this.heartbeats.push(input);
    return { serverTime: this.now(), cancelInstructionIds: this.cancelIds.splice(0), interruptSessionIds: this.interruptSessionIds.splice(0), interruptThreadIds: this.interruptThreadIds.splice(0) };
  }

  private openInstructions() {
    return [...this.instructions.values()]
      .filter((i) => !["archived", "canceled", "failed"].includes(i.status))
      .map((i) => ({ id: i.id, title: i.title ?? "", status: i.status, phase: i.phase, revision: i.revision, projectId: i.projectId, talkingWithCeo: i.projectId ? this.talking.has(i.projectId) : false }));
  }

  memberWorkAvailable(i: Instr): boolean {
    // V1 と同じ: 追加の依頼は running・needs_decision・review なら段階に関係なく
    const followUp = this.inputs.some((x) => x.instructionId === i.id && x.status === "pending");
    if (followUp && ["running", "needs_decision", "review"].includes(i.status)) return true;
    if (i.status !== "running" || i.phase !== "members") return false;
    const tasks = [...this.tasks.values()].filter((t) => t.instructionId === i.id && t.kind === "work");
    if (tasks.some((t) => t.status === "pending")) return true;
    for (const s of this.sessions.values()) {
      if (s.instructionId !== i.id || s.role !== "member") continue;
      if (s.status === "running" || s.status === "quota_wait" || s.status === "awaiting_approval") return true;
      if (s.status === "paused" && s.pauseReason !== "question") {
        const d = [...this.decisions.values()].find((d) => d.sessionId === s.id && d.kind === "interrupted");
        if (d && d.status === "answered") return true;
      }
      if (this.inputs.some((x) => x.sessionId === s.id && x.status === "pending")) return true;
    }
    return false;
  }

  async claim(input: ClaimInput): Promise<ClaimOutput | null> {
    this.claims.push(input);
    const now = this.now();
    if (input.kinds.includes("finalize")) {
      for (const i of this.instructions.values()) {
        if (i.status === "done" && i.approvedAt !== null && i.finalizedAt === null && !i.leased) {
          i.leased = true;
          return { kind: "finalize", instruction: { ...this.summary(i), feedback: null, attempt: 1, originThreadId: i.originThreadId }, workspaces: [...this.workspaces.values()].filter((w) => w.instructionId === i.id), project: this.projects.get(i.projectId!)! };
        }
      }
    }
    if (input.kinds.includes("thread")) {
      const pick = [...this.threads.values()]
        .filter((t) => !t.leased && (t.notBefore === null || t.notBefore <= now) && !input.activeThreadIds.includes(t.id))
        .map((t) => ({ t, items: this.pendingInbox(t.id) }))
        .filter((x) => x.items.some((i) => i.wakes))
        .sort((a, b) => a.items[0]!.createdAt - b.items[0]!.createdAt)[0];
      if (pick) {
        pick.t.leased = true;
        return {
          kind: "thread",
          thread: { id: pick.t.id, kind: pick.t.kind, projectId: pick.t.projectId, agentId: pick.t.agentId, currentSessionId: pick.t.currentSessionId, sessionTurns: pick.t.sessionTurns, lastSeq: this.messagesOf(pick.t.id).length },
          inbox: pick.items.map(({ consumed: _c, ...i }) => i),
          context: {
            recentMessages: this.messagesOf(pick.t.id).slice(-30),
            openInstructions: this.openInstructions(),
            projects: [...this.projects.values()],
            repos: this.repos,
            talkingProjectIds: [...this.talking],
            viewing: null,
          },
        };
      }
    }
    if (input.kinds.includes("instruction") && !input.quotaPaused) {
      for (const i of this.instructions.values()) {
        if (i.leased || input.activeInstructionIds.includes(i.id) || (i.notBefore !== null && i.notBefore > now)) continue;
        if (!this.memberWorkAvailable(i)) continue;
        i.leased = true;
        return {
          kind: "instruction",
          instruction: { ...this.summary(i), feedback: null, attempt: 1, originThreadId: i.originThreadId },
          tasks: [...this.tasks.values()].filter((t) => t.instructionId === i.id).map((t) => ({ ...t })),
          workspaces: [...this.workspaces.values()].filter((w) => w.instructionId === i.id).map((w) => ({ ...w })),
          sessions: [...this.sessions.values()].filter((s) => s.instructionId === i.id).map((s) => ({ ...s })),
          project: this.projects.get(i.projectId!)!,
        };
      }
    }
    return null;
  }

  async postMessage(threadId: string, input: RunnerPostMessageInput) {
    const existing = this.messagesOf(threadId).find((m) => m.id === input.id);
    if (existing) return existing;
    return this.addMessage(threadId, { ...input, ref: input.ref ?? {} });
  }
  async patchMessage(threadId: string, messageId: string, input: RunnerPatchMessageInput) {
    const list = this.messagesOf(threadId);
    const i = list.findIndex((m) => m.id === messageId);
    if (i < 0) return null;
    if (input.delete) {
      list.splice(i, 1);
      return null;
    }
    const m = list[i]!;
    const { delete: _d, ...rest } = input;
    Object.assign(m, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), { updatedAt: this.now() });
    return m;
  }
  async stream(threadId: string, input: StreamInput) {
    this.streams.push({ ...input, threadId });
  }
  async pushInbox(threadId: string, input: RunnerInboxInput) {
    if (!this.threads.has(threadId)) throw new Error(`no thread ${threadId}`);
    this.addInbox(threadId, input);
  }
  async turnDone(threadId: string, input: TurnDoneInput) {
    this.turnDones.push({ ...input, threadId });
    for (const id of input.consumedInboxIds) {
      const it = this.inbox.find((x) => x.id === id);
      if (it) it.consumed = true;
    }
    for (const mid of input.ackMessageIds) {
      const m = this.messagesOf(threadId).find((x) => x.id === mid);
      if (m) m.reaction = "ack";
    }
    const t = this.threads.get(threadId)!;
    t.leased = false;
    if (t.currentSessionId !== input.sessionId) t.sessionTurns = 0;
    t.currentSessionId = input.sessionId;
    t.sessionTurns += input.numTurns;
    t.awaitingReply = input.awaitingReply;
  }
  async releaseThread(threadId: string, input: ThreadReleaseInput) {
    this.releases.push({ kind: "thread", id: threadId, reason: input.reason, notBefore: input.notBefore });
    const t = this.threads.get(threadId)!;
    t.leased = false;
    t.notBefore = input.notBefore;
  }
  async createProposal(input: RunnerCreateProposalInput) {
    const p: ProjectProposal = {
      id: input.id,
      threadId: input.threadId,
      messageId: input.messageId,
      status: "pending",
      projectId: null,
      name: input.name,
      slug: input.slug,
      goal: input.goal,
      summary: input.summary,
      workspace: input.workspace.kind === "repo" ? { kind: "repo", repoPath: input.workspace.repoPath, repoName: input.workspace.repoPath } : { kind: "baton" },
      leader: input.leader,
      members: input.members,
      createdAt: this.now(),
      decidedAt: null,
    };
    this.proposals.push(p);
    return p;
  }
  /** CEO が「立てる」（W28 の振る舞い。COO の受信箱に project_created） */
  acceptProposal(id: string, workspace?: { kind: "baton" } | { kind: "repo"; repoPath: string }): ProjectWithTeam {
    const p = this.proposals.find((x) => x.id === id)!;
    const ws = workspace ?? (p.workspace.kind === "repo" ? { kind: "repo" as const, repoPath: p.workspace.repoPath } : { kind: "baton" as const });
    const project = this.addProject(
      { slug: p.slug, name: p.name, goal: p.goal, workspaceKind: ws.kind, repoPath: ws.kind === "repo" ? ws.repoPath : null, repoName: ws.kind === "repo" ? "sample-repo" : null },
      { leader: p.leader.name, members: p.members.map((m) => ({ name: m.name, profile: m.profile })) },
    );
    p.status = "accepted";
    p.projectId = project.id;
    this.addInbox(COO_THREAD_ID, { kind: "project_created", wakes: true, payload: { text: `プロジェクト「${project.name}」が立ちました`, projectId: project.id } });
    return project;
  }
  async createProject(input: RunnerCreateProjectInput) {
    const project = this.addProject({ slug: input.slug, name: input.name, goal: input.goal, summary: input.summary }, { leader: input.leader.name, members: input.members.map((m) => ({ name: m.name, profile: m.profile })) });
    return { project, leaderThreadId: `thread-${project.id}` };
  }
  async createInstruction(input: RunnerCreateInstructionInput) {
    const existing = this.instructions.get(input.id);
    if (existing) return this.summary(existing);
    const project = this.projects.get(input.projectId)!;
    const i: Instr = {
      id: input.id,
      clientId: input.id,
      body: input.body,
      title: input.title,
      status: input.phase === "members" ? "running" : "queued",
      statusChangedAt: this.now(),
      projectId: input.projectId,
      projectName: project.name,
      resultSummary: null,
      openDecisionId: null,
      openDecisionCount: 0,
      activeSessionCount: 0,
      activity: null,
      revision: 1,
      phase: input.phase,
      talkingWithCeo: false,
      costUsdEst: 0,
      notBefore: null,
      error: null,
      taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
      activeAgents: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      completedAt: null,
      leased: false,
      finalizedAt: null,
      approvedAt: null,
      originThreadId: input.originThreadId,
    };
    this.instructions.set(i.id, i);
    return this.summary(i);
  }
  async patchInstruction(id: string, patch: RunnerInstructionPatch) {
    const i = this.instructions.get(id);
    if (!i) throw new ConflictError("no instruction");
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== i.revision) throw new StaleRevisionError("stale", { revision: i.revision });
    // Worker と同じ条件（routes/runner/instructions.ts）
    if (patch.reopen || (patch.status === "running" && canReopen(i.status))) {
      if (!canReopen(i.status)) throw new ConflictError("cannot reopen", { status: i.status });
      i.status = "running";
      i.approvedAt = null;
    } else if (patch.status && patch.status !== i.status && !canSystemTransition(i.status, patch.status)) {
      throw new ConflictError("transition not allowed", { status: i.status, to: patch.status });
    }
    if (patch.revisionBump) i.revision += 1;
    if (patch.status) i.status = patch.status;
    if (patch.phase !== undefined) i.phase = patch.phase;
    if (patch.resultSummary !== undefined) i.resultSummary = patch.resultSummary;
    if (patch.error !== undefined) i.error = patch.error;
    if (patch.title) i.title = patch.title;
    if (patch.status === "failed" || patch.status === "needs_decision") i.leased = false;
    if (patch.phase && patch.phase !== "members") i.leased = false;
    return this.summary(i);
  }
  async releaseInstruction(id: string, input: InstructionReleaseInput) {
    this.releases.push({ kind: "instruction", id, reason: input.reason, notBefore: input.notBefore });
    const i = this.instructions.get(id);
    if (i) {
      i.leased = false;
      i.notBefore = input.notBefore;
    }
  }
  /** メンバーの段階のクレームが終わった（lease を外す。Worker は lease 切れか次の段階で外す） */
  unlease(id: string): void {
    const i = this.instructions.get(id);
    if (i) i.leased = false;
  }
  async finalized(id: string, input: FinalizedInput) {
    this.finalizedLog.push({ id, input });
    const i = this.instructions.get(id)!;
    i.finalizedAt = this.now();
    i.leased = false;
  }
  async createTasks(input: CreateTasksInput) {
    return input.tasks.map((t) => {
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
        paths: t.paths,
        status: "pending",
        resultSummary: null,
        round: t.round,
        seq: t.seq,
        startedAt: null,
        finishedAt: null,
        updatedAt: this.now(),
      };
      this.tasks.set(task.id, task);
      return { ...task };
    });
  }
  async patchTask(id: string, patch: TaskPatch) {
    const t = this.tasks.get(id)!;
    Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: this.now() });
    return { ...t };
  }
  async createSession(input: CreateSessionInput) {
    const s: AgentSessionSummary = {
      id: input.id,
      threadId: input.threadId,
      instructionId: input.instructionId,
      agentId: input.agentId,
      role: input.role,
      projectId: input.projectId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      title: input.title,
      model: input.model,
      status: "pending",
      pauseReason: null,
      activity: null,
      activityAt: null,
      turns: 0,
      costUsdEst: 0,
      lastSeq: 0,
      error: null,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      updatedAt: this.now(),
    };
    this.sessions.set(s.id, s);
    return { ...s };
  }
  async patchSession(id: string, patch: SessionPatch) {
    const s = this.sessions.get(id);
    if (!s) throw new ConflictError("no session");
    if (patch.status) s.status = patch.status;
    if (patch.pauseReason !== undefined) s.pauseReason = patch.pauseReason;
    if (patch.activity !== undefined) s.activity = patch.activity;
    if (patch.turnsDelta) s.turns += patch.turnsDelta;
    if (patch.costUsdDelta) s.costUsdEst += patch.costUsdDelta;
    if (patch.error !== undefined) s.error = patch.error;
    if (patch.ended) s.endedAt = this.now();
    if (patch.started) s.startedAt ??= this.now();
    return { ...s };
  }
  async appendTranscript(input: AppendTranscriptInput) {
    this.transcript.push(...input.items);
    for (const it of input.items) {
      const s = this.sessions.get(it.sessionId);
      if (s) s.lastSeq = Math.max(s.lastSeq, it.seq);
    }
  }
  async pendingInputs(sessionId: string) {
    return this.inputs.filter((i) => i.sessionId === sessionId && i.status === "pending").map((i) => ({ ...i }));
  }
  async inputDelivered(inputId: string) {
    const i = this.inputs.find((x) => x.id === inputId);
    if (i) {
      i.status = "delivered";
      i.deliveredAt = this.now();
    }
  }
  private decision(input: { id: string; instructionId: string; taskId: string | null; askedByAgentId: string | null; kind: Decision["kind"]; sessionId: string | null; question: string }): Decision {
    return {
      ...input,
      options: [],
      toolName: null,
      toolInput: null,
      status: "open",
      answer: null,
      verdict: null,
      suggestion: null,
      suggestionVerdict: null,
      suggestionAt: null,
      answeredAt: null,
      createdAt: this.now(),
    };
  }
  async createApproval(input: CreateApprovalInput) {
    const d = { ...this.decision({ ...input, kind: "approval" }), toolName: input.toolName, toolInput: input.toolInput };
    this.decisions.set(d.id, d);
    return { ...d };
  }
  async createDecision(input: CreateDecisionInput) {
    const d = this.decision({ ...input, id: input.id ?? randomUUID() });
    if (input.fromApprovalId) {
      const a = this.decisions.get(input.fromApprovalId);
      if (a) a.status = "canceled";
    }
    this.decisions.set(d.id, d);
    return { ...d };
  }
  async getDecision(id: string) {
    const d = this.decisions.get(id);
    if (!d) throw new ConflictError("no decision");
    return { ...d };
  }
  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    this.artifacts.push(input);
    return { id: randomUUID(), instructionId: input.instructionId, taskId: input.taskId, projectSlug: null, relPath: input.relPath, title: input.title, mime: input.mime, sizeBytes: input.sizeBytes, createdAt: this.now(), sha256: input.sha256, previewText: input.previewText };
  }
  async listWorkspaces(query: { status?: string; instructionId?: string }) {
    return [...this.workspaces.values()].filter((w) => (!query.status || w.status === query.status) && (!query.instructionId || w.instructionId === query.instructionId)).map((w) => ({ ...w }));
  }
  async createWorkspace(input: CreateWorkspaceInput) {
    const w: Workspace = { ...input, headSha: null, status: "active", diffStat: [], diffTruncated: false, error: null, createdAt: this.now(), updatedAt: this.now(), finalizedAt: null };
    this.workspaces.set(w.id, w);
    return { ...w };
  }
  async patchWorkspace(id: string, patch: WorkspacePatch) {
    const w = this.workspaces.get(id)!;
    if (patch.status) w.status = patch.status;
    if (patch.headSha !== undefined) w.headSha = patch.headSha;
    if (patch.diffStat) w.diffStat = patch.diffStat;
    if (patch.diffTruncated !== undefined) w.diffTruncated = patch.diffTruncated;
    if (patch.error !== undefined) w.error = patch.error;
    if (patch.finalized) w.finalizedAt = this.now();
    if (patch.diffPatch !== undefined) w.diffPatch = patch.diffPatch;
    return { ...w };
  }
  async putRepos(input: PutReposInput) {
    this.repos = input.items.map((r) => ({ ...r, projectId: null, seenAt: this.now() }));
  }
}
