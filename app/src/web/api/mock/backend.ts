// モックのバックエンド（?mock=1 のときだけ main.tsx が動的 import する）。
// メモリ上のデータと擬似 WebSocket で、Worker（V1）とランナー（V3）が無くても全画面が動くようにする。
// COO・リーダー・メンバーの振る舞いは偽 claude の台本（15.2）に寄せた小さな台本で再生する（シナリオ A）。
import {
  API_PATHS,
  COO_AGENT_ID,
  COO_THREAD_ID,
  EMPTY_QUOTA,
  LIMITS,
  REPLYING_ACTIVITY,
  THINKING_ACTIVITY,
  compareSidebarProjects,
  countInstructions,
  deriveAgentState,
  isProjectInProgress,
  nextStatus,
  type Agent,
  type AgentLive,
  type AgentSessionSummary,
  type Artifact,
  type AuthorKind,
  type BotAuditItem,
  type BotScope,
  type BotTokenView,
  type CeoAction,
  type Decision,
  type InstructionDetail,
  type InstructionStatus,
  type InstructionSummary,
  type MemberProfile,
  type MessageRef,
  type OrgSnapshot,
  type ProfileView,
  type ProjectProposal,
  type ProjectWithTeam,
  type PushSubscriptionView,
  type QuotaStatus,
  type RepoCandidate,
  type RunnerStatus,
  type ServerEvent,
  type SessionInfo,
  type SessionInput,
  type SidebarOutput,
  type Task,
  type ThreadMessage,
  type ThreadMessageKind,
  type ThreadSummary,
  type TranscriptItem,
  type Workspace,
  type WorkspaceDiff,
} from "@baton/shared";
import type { SocketLike } from "../ws.ts";
import type { InstRec, MockOptions, ThreadRec, TranscriptStore } from "./types.ts";

export type { MockOptions } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

export function uuid(): string {
  return crypto.randomUUID();
}

function json(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

type TransitionLog = { id: string; instructionId: string; from: InstructionStatus; to: InstructionStatus; at: number; undone: boolean; action: CeoAction };

export type Author = { kind: AuthorKind; agentId: string | null; name: string | null };
export const COO_AUTHOR: Author = { kind: "coo", agentId: COO_AGENT_ID, name: "COO" };
const SYSTEM_AUTHOR: Author = { kind: "system", agentId: null, name: null };

/** 待っている間に dispose されたら、続きを実行しない */
class Disposed extends Error {}

export type MemberStep =
  | { kind: "think"; text: string }
  | { kind: "todo"; todos: { content: string; status: "pending" | "in_progress" | "completed" }[] }
  | { kind: "tool"; tool: string; input: Record<string, unknown>; result: string; activity: string; summary: string; resultSummary?: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; patch: string[]; added: number; removed: number }
  | { kind: "text"; text: string }
  | { kind: "approval"; command: string };

export class MockBackend {
  readonly threads = new Map<string, ThreadRec>();
  readonly insts = new Map<string, InstRec>();
  readonly transcripts: TranscriptStore = new Map();
  readonly proposals = new Map<string, ProjectProposal>();
  readonly projects: ProjectWithTeam[] = [];
  readonly sockets = new Set<MockSocket>();
  readonly transitions: TransitionLog[] = [];
  readonly inputs: SessionInput[] = [];
  /** 一度でも画面に出しうる文字列（いまの動きなど、あとで変わるもの。F7 の検査用） */
  readonly seenTexts = new Set<string>();
  repos: RepoCandidate[] = [];
  profiles: ProfileView[] = [];
  pushSubs: PushSubscriptionView[] = [];
  botTokens: BotTokenView[] = [];
  botAudit: BotAuditItem[] = [];
  loggedIn: boolean;
  csrf = uuid();
  runner: RunnerStatus;
  quota: QuotaStatus;
  estimatedCostTodayUsd = 3.42;
  vapidPublicKey: string | null = "BMockVapidPublicKeyForBatonDemoOnly0000000000000000000000000000000000000000000000000000";
  /** 動いている流れ（指示 ID・スレッド ID）。取消・中断で止める */
  private readonly cancelled = new Set<string>();
  /** 承認・再開の回答を待っている流れ */
  private readonly waiters = new Map<string, (answer: { verdict?: "allow" | "deny"; answer?: string }) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  readonly speed: number;
  readonly still: boolean;
  private readonly listDelayMs: number;
  private readonly base: () => number;
  /** 種データを作る間は時間を進めるだけで待たない（過去の出来事を台本どおりに作る） */
  instant = false;
  private offset = 0;
  /** 種データの作成が終わったら解決する（REST はこれを待つ） */
  ready: Promise<void> = Promise.resolve();

  constructor(opts: MockOptions = {}) {
    this.loggedIn = !opts.loggedOut;
    this.speed = opts.speed ?? 1;
    this.still = opts.still ?? false;
    this.listDelayMs = opts.listDelayMs ?? 0;
    this.base = opts.now ?? (() => Date.now());
    const now = this.now();
    this.runner = {
      online: true,
      lastHeartbeatAt: now - 12_000,
      activeInstructionIds: [],
      activeSessionIds: [],
      version: "2.0.0",
      tailnetUrl: "https://rikumac-mini.mock.ts.net",
      claudeVersion: "2.1.303",
      claudeAuth: "ok",
    };
    this.quota = {
      ...EMPTY_QUOTA,
      observedAt: now - 40_000,
      fiveHour: { utilization: 0.67, resetsAt: now + 2 * HOUR + 14 * MIN },
      sevenDay: { utilization: 0.28, resetsAt: now + 4 * 24 * HOUR },
      status: "allowed",
    };
    this.addThread({
      id: COO_THREAD_ID,
      kind: "coo",
      projectId: null,
      projectName: null,
      agentName: "COO",
      status: "idle",
      activity: null,
      awaitingReply: false,
      talkingWithCeo: false,
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of [...this.sockets]) s.close();
  }

  /** 画面に出る可能性がある文字列を全部まとめたもの（F7 で「AI が書いた文章・名前」として扱う） */
  dynamicTextDump(): string {
    const all = {
      threads: [...this.threads.values()],
      insts: [...this.insts.values()],
      transcripts: [...this.transcripts.values()],
      proposals: [...this.proposals.values()],
      projects: this.projects,
      repos: this.repos,
      profiles: this.profiles,
      push: this.pushSubs,
      tokens: this.botTokens,
      audit: this.botAudit,
      inputs: this.inputs,
      seen: [...this.seenTexts],
    };
    const leaves: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") {
        leaves.push(v);
        // 改行や Markdown で分かれて描かれる断片も拾えるように、行ごと・記号を外した形も入れる
        for (const line of v.split("\n")) leaves.push(line.replace(/^[\s>*#\-\d.]+/, "").replace(/\*\*/g, ""));
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(all);
    return leaves.join("\n\u0000\n");
  }

  login(): void {
    this.loggedIn = true;
  }

  // ───────────── 時間 ─────────────

  now(): number {
    return this.base() + this.offset;
  }

  /** 種データを作るときの時刻（今からの差。負の値で過去へ） */
  travel(ms: number): void {
    this.offset = ms;
  }

  sleep(ms: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Disposed());
    if (this.instant) {
      this.offset += ms;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (this.disposed) reject(new Disposed());
        else resolve();
      }, Math.max(0, ms / this.speed));
      this.timers.add(t);
    });
  }

  /** 流れを動かす（dispose と取消で止まった例外は握りつぶす） */
  run(fn: () => Promise<void>): void {
    void fn().catch((e) => {
      if (e instanceof Disposed || e instanceof Cancelled) return;
      console.error(e);
    });
  }

  private checkCancelled(key: string | null): void {
    if (this.disposed) throw new Disposed();
    if (key && this.cancelled.has(key)) throw new Cancelled();
  }

  // ───────────── 配信 ─────────────

  broadcast(ev: ServerEvent, filter?: (s: MockSocket) => boolean): void {
    for (const s of this.sockets) if (!filter || filter(s)) s.deliver(ev);
  }

  // ───────────── スレッドと発言 ─────────────

  addThread(summary: ThreadRec["summary"]): ThreadRec {
    const rec: ThreadRec = { summary, messages: [], lastReadSeq: 0 };
    this.threads.set(summary.id, rec);
    return rec;
  }

  threadView(rec: ThreadRec): ThreadSummary {
    const last = [...rec.messages].reverse().find((m) => m.status !== "streaming" || m.body) ?? null;
    const lastSeq = rec.messages.reduce((m, x) => Math.max(m, x.seq), 0);
    const unread = rec.messages.filter((m) => m.notify && m.status === "complete" && m.seq > rec.lastReadSeq).length;
    return {
      ...rec.summary,
      unread,
      lastSeq,
      lastReadSeq: rec.lastReadSeq,
      lastMessage: last ? { authorKind: last.authorKind, preview: last.body.replace(/\s+/g, " ").slice(0, 120), createdAt: last.createdAt } : null,
    };
  }

  emitThread(threadId: string): void {
    const rec = this.threads.get(threadId);
    if (rec) this.broadcast({ t: "thread.updated", thread: this.threadView(rec) });
  }

  setThread(threadId: string, patch: Partial<ThreadRec["summary"]>): void {
    if (patch.activity) this.seenTexts.add(patch.activity);
    const rec = this.threads.get(threadId);
    if (!rec) return;
    rec.summary = { ...rec.summary, ...patch };
    this.emitThread(threadId);
  }

  addMessage(
    threadId: string,
    author: Author,
    body: string,
    opts: {
      kind?: ThreadMessageKind;
      notify?: boolean;
      instructionId?: string | null;
      sessionId?: string | null;
      ref?: MessageRef;
      status?: ThreadMessage["status"];
      clientId?: string | null;
      at?: number;
      reaction?: "ack" | null;
    } = {},
  ): ThreadMessage {
    const rec = this.threads.get(threadId);
    if (!rec) throw new Error(`thread ${threadId}`);
    const at = opts.at ?? this.now();
    const seq = rec.messages.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
    const msg: ThreadMessage = {
      id: uuid(),
      threadId,
      seq,
      authorKind: author.kind,
      authorAgentId: author.agentId,
      authorName: author.name,
      kind: opts.kind ?? "chat",
      body,
      instructionId: opts.instructionId ?? null,
      sessionId: opts.sessionId ?? null,
      ref: opts.ref ?? {},
      status: opts.status ?? "complete",
      reaction: opts.reaction ?? null,
      notify: opts.notify ?? false,
      clientId: opts.clientId ?? null,
      createdAt: at,
      updatedAt: at,
    };
    rec.messages.push(msg);
    this.emitMessage(msg);
    this.emitThread(threadId);
    return msg;
  }

  emitMessage(msg: ThreadMessage): void {
    const truncated = msg.body.length > LIMITS.broadcastMaxChars;
    this.broadcast({ t: "message.upserted", message: truncated ? { ...msg, body: msg.body.slice(0, LIMITS.broadcastMaxChars) } : msg, bodyTruncated: truncated });
  }

  patchMessage(msg: ThreadMessage, patch: Partial<ThreadMessage>): ThreadMessage {
    const rec = this.threads.get(msg.threadId);
    if (!rec) return msg;
    const idx = rec.messages.findIndex((m) => m.id === msg.id);
    if (idx < 0) return msg;
    const next = { ...rec.messages[idx]!, ...patch, updatedAt: Math.max(this.now(), rec.messages[idx]!.updatedAt + 1) };
    rec.messages[idx] = next;
    this.emitMessage(next);
    this.emitThread(msg.threadId);
    return next;
  }

  /**
   * 返事をストリーミングで書く（4.7）。入力中の印 → いまの動き → 文字が伸びる → 完成。
   * 中断（thread の interrupt）されたら、そこまでの本文で canceled にする
   */
  async stream(
    threadId: string,
    author: Author,
    text: string,
    opts: {
      kind?: ThreadMessageKind;
      notify?: boolean;
      instructionId?: string | null;
      ref?: MessageRef;
      activities?: string[];
      awaitingReply?: boolean;
      thinkMs?: number;
    } = {},
  ): Promise<ThreadMessage> {
    const key = `thread:${threadId}`;
    this.cancelled.delete(key);
    this.setThread(threadId, { status: "running", activity: THINKING_ACTIVITY, awaitingReply: false });
    let msg = this.addMessage(threadId, author, "", { ...opts, status: "streaming" });
    const subscribed = (s: MockSocket) => s.sub.threadId === threadId;
    try {
      await this.sleep(opts.thinkMs ?? 500);
      for (const a of opts.activities ?? []) {
        this.checkCancelled(key);
        this.broadcast({ t: "message.delta", threadId, messageId: msg.id, offset: 0, delta: "", activity: a }, subscribed);
        this.setThread(threadId, { activity: a });
        await this.sleep(650);
      }
      this.setThread(threadId, { activity: REPLYING_ACTIVITY });
      let offset = 0;
      const step = 3;
      while (offset < text.length) {
        this.checkCancelled(key);
        const delta = text.slice(offset, offset + step);
        this.broadcast({ t: "message.delta", threadId, messageId: msg.id, offset, delta, activity: REPLYING_ACTIVITY }, subscribed);
        offset += delta.length;
        // 本文も途中まで覚える（再接続したら REST の本文から続ける）
        const rec = this.threads.get(threadId);
        const idx = rec?.messages.findIndex((m) => m.id === msg.id) ?? -1;
        if (rec && idx >= 0) rec.messages[idx] = { ...rec.messages[idx]!, body: text.slice(0, offset) };
        await this.sleep(text[offset - 1] === "\n" ? 140 : 38);
      }
      msg = this.patchMessage(msg, { body: text, status: "complete" });
      this.setThread(threadId, { status: "idle", activity: null, awaitingReply: opts.awaitingReply ?? false });
      return msg;
    } catch (e) {
      if (e instanceof Cancelled) {
        const rec = this.threads.get(threadId);
        const cur = rec?.messages.find((m) => m.id === msg.id);
        this.patchMessage(msg, { status: "canceled", body: cur?.body ?? "" });
        this.setThread(threadId, { status: "idle", activity: null });
        this.cancelled.delete(key);
      }
      throw e;
    }
  }

  // ───────────── プロジェクトとチーム ─────────────

  addProject(o: {
    slug: string;
    name: string;
    goal: string;
    summary?: string;
    repo?: { path: string; name: string; baseBranch: string } | null;
    leader: { name: string; specialty: string };
    members: { name: string; specialty: string; profile: MemberProfile }[];
  }): ProjectWithTeam {
    const id = `proj-${o.slug}`;
    const agents: Agent[] = [
      { id: `agent-${o.slug}-leader`, projectId: id, role: "leader", name: o.leader.name, specialty: o.leader.specialty, model: "sonnet", profile: "leader", active: true },
      ...o.members.map((m, i) => ({
        id: `agent-${o.slug}-m${i + 1}`,
        projectId: id,
        role: "member" as const,
        name: m.name,
        specialty: m.specialty,
        model: "sonnet",
        profile: m.profile,
        active: true,
      })),
    ];
    const project: ProjectWithTeam = {
      id,
      slug: o.slug,
      name: o.name,
      summary: o.summary ?? "",
      goal: o.goal,
      status: "active",
      workspaceKind: o.repo ? "repo" : "baton",
      repoPath: o.repo?.path ?? null,
      repoName: o.repo?.name ?? null,
      baseBranch: o.repo?.baseBranch ?? null,
      agents,
      updatedAt: this.now(),
    };
    this.projects.push(project);
    this.addThread({
      id: `thread-leader-${o.slug}`,
      kind: "leader",
      projectId: id,
      projectName: o.name,
      agentName: o.leader.name,
      status: "idle",
      activity: null,
      awaitingReply: false,
      talkingWithCeo: false,
    });
    if (o.repo) {
      const r = this.repos.find((x) => x.path === o.repo!.path);
      if (r) r.projectId = id;
    }
    return project;
  }

  project(id: string | null): ProjectWithTeam | null {
    return id ? (this.projects.find((p) => p.id === id) ?? null) : null;
  }

  leaderOf(p: ProjectWithTeam): Agent {
    return p.agents.find((a) => a.role === "leader")!;
  }

  leaderThreadId(p: ProjectWithTeam): string {
    return `thread-leader-${p.slug}`;
  }

  leaderAuthor(p: ProjectWithTeam): Author {
    const l = this.leaderOf(p);
    return { kind: "leader", agentId: l.id, name: l.name };
  }

  // ───────────── 指示 ─────────────

  addInstruction(o: {
    project: ProjectWithTeam | null;
    title: string;
    body: string;
    status?: InstructionStatus;
    phase?: InstructionSummary["phase"];
    revision?: number;
    at?: number;
    resultSummary?: string | null;
    error?: string | null;
    originMessageId?: string | null;
  }): InstRec {
    const at = o.at ?? this.now();
    const id = uuid();
    const rec: InstRec = {
      summary: {
        id,
        clientId: uuid(),
        body: o.body,
        title: o.title,
        status: o.status ?? "queued",
        statusChangedAt: at,
        projectId: o.project?.id ?? null,
        projectName: o.project?.name ?? null,
        resultSummary: o.resultSummary ?? null,
        openDecisionId: null,
        openDecisionCount: 0,
        activeSessionCount: 0,
        activity: null,
        revision: o.revision ?? 1,
        phase: o.phase ?? null,
        talkingWithCeo: false,
        costUsdEst: 0,
        notBefore: null,
        error: o.error ?? null,
        taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
        activeAgents: [],
        createdAt: at,
        updatedAt: at,
        completedAt: o.status === "done" ? at : null,
      },
      feedback: null,
      attempt: 1,
      archivedFrom: null,
      originThreadId: COO_THREAD_ID,
      originMessageId: o.originMessageId ?? null,
      finalizedAt: null,
      tasks: [],
      decisions: [],
      artifacts: [],
      sessions: [],
      workspaces: [],
      patch: null,
      reviewSummary: null,
    };
    this.insts.set(id, rec);
    this.refreshSummary(rec);
    this.broadcast({ t: "instruction.upserted", instruction: rec.summary });
    this.emitCounts(rec.summary.projectId);
    return rec;
  }

  /** 件数・動いているエージェント・いまの動きを、タスク・セッション・判断から出し直す */
  refreshSummary(rec: InstRec): void {
    const work = rec.tasks.filter((t) => t.kind === "work");
    const active = rec.sessions.filter((s) => s.status === "running" || s.status === "awaiting_approval" || s.status === "pending");
    const open = rec.decisions.filter((d) => d.status === "open");
    const p = this.project(rec.summary.projectId);
    const agents = active
      .map((s) => p?.agents.find((a) => a.id === s.agentId))
      .filter((a): a is Agent => !!a)
      .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i)
      .slice(0, 3)
      .map((a) => ({ agentId: a.id, name: a.name, role: a.role }));
    const latest = [...active].sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0))[0];
    rec.summary = {
      ...rec.summary,
      taskCounts: {
        total: work.length,
        done: work.filter((t) => t.status === "done").length,
        running: work.filter((t) => t.status === "running").length,
        failed: work.filter((t) => t.status === "failed").length,
      },
      activeSessionCount: active.length,
      activeAgents: agents,
      activity: rec.summary.status === "running" ? (latest?.activity ?? rec.summary.activity) : null,
      openDecisionCount: open.length,
      openDecisionId: open[0]?.id ?? null,
      costUsdEst: Math.round(rec.sessions.reduce((n, s) => n + s.costUsdEst, 0) * 100) / 100,
    };
  }

  setInst(rec: InstRec, patch: Partial<InstructionSummary>): void {
    const statusChanged = patch.status !== undefined && patch.status !== rec.summary.status;
    const now = this.now();
    rec.summary = {
      ...rec.summary,
      ...patch,
      ...(statusChanged ? { statusChangedAt: now } : {}),
      ...(patch.status === "done" ? { completedAt: now } : {}),
      updatedAt: Math.max(now, rec.summary.updatedAt + 1),
    };
    this.refreshSummary(rec);
    this.broadcast({ t: "instruction.upserted", instruction: rec.summary });
    this.emitCounts(rec.summary.projectId);
    this.syncRunner();
  }

  touchInst(rec: InstRec): void {
    this.setInst(rec, {});
  }

  emitCounts(projectId: string | null): void {
    if (!projectId) return;
    const counts = countInstructions(
      [...this.insts.values()].filter((r) => r.summary.projectId === projectId).map((r) => r.summary),
      this.now(),
    );
    this.broadcast({ t: "project.counts", projectId, counts });
  }

  private syncRunner(): void {
    const active = [...this.insts.values()].filter((r) => r.summary.status === "running");
    this.runner = {
      ...this.runner,
      lastHeartbeatAt: this.now(),
      activeInstructionIds: active.map((r) => r.summary.id).slice(0, 16),
      activeSessionIds: active.flatMap((r) => r.sessions.filter((s) => s.status === "running").map((s) => s.id)).slice(0, 16),
    };
  }

  // ───────────── セッションとトランスクリプト ─────────────

  addSession(rec: InstRec, o: { role: AgentSessionSummary["role"]; agentId: string | null; title: string; threadId?: string | null; taskId?: string | null; workspaceId?: string | null; status?: AgentSessionSummary["status"]; at?: number }): AgentSessionSummary {
    const at = o.at ?? this.now();
    const s: AgentSessionSummary = {
      id: uuid(),
      threadId: o.threadId ?? null,
      instructionId: rec.summary.id,
      agentId: o.agentId,
      role: o.role,
      projectId: rec.summary.projectId,
      taskId: o.taskId ?? null,
      workspaceId: o.workspaceId ?? null,
      title: o.title,
      model: o.role === "coo" ? "opus" : "sonnet",
      status: o.status ?? "running",
      pauseReason: null,
      activity: null,
      activityAt: null,
      turns: 0,
      costUsdEst: 0,
      lastSeq: 0,
      error: null,
      createdAt: at,
      startedAt: at,
      endedAt: null,
      updatedAt: at,
    };
    rec.sessions.push(s);
    this.transcripts.set(s.id, []);
    this.broadcast({ t: "session.upserted", session: s });
    this.touchInst(rec);
    return s;
  }

  setSession(rec: InstRec, s: AgentSessionSummary, patch: Partial<AgentSessionSummary>): AgentSessionSummary {
    if (patch.activity) this.seenTexts.add(patch.activity);
    const idx = rec.sessions.findIndex((x) => x.id === s.id);
    const next = { ...rec.sessions[idx]!, ...patch, updatedAt: this.now() };
    rec.sessions[idx] = next;
    this.broadcast({ t: "session.upserted", session: next });
    this.touchInst(rec);
    return next;
  }

  addItem(
    s: AgentSessionSummary,
    kind: TranscriptItem["kind"],
    o: Partial<Pick<TranscriptItem, "author" | "toolName" | "toolUseId" | "summary" | "body" | "isError" | "truncated">> & { at?: number } = {},
  ): TranscriptItem {
    const list = this.transcripts.get(s.id) ?? [];
    const seq = list.length;
    const item: TranscriptItem = {
      id: uuid(),
      sessionId: s.id,
      threadId: s.threadId,
      instructionId: s.instructionId,
      seq,
      kind,
      author: o.author ?? "claude",
      toolName: o.toolName ?? null,
      toolUseId: o.toolUseId ?? null,
      parentToolUseId: null,
      summary: o.summary ?? "",
      body: o.body ?? {},
      truncated: o.truncated ?? false,
      isError: o.isError ?? false,
      createdAt: o.at ?? this.now(),
    };
    list.push(item);
    this.transcripts.set(s.id, list);
    this.broadcast({ t: "transcript.appended", items: [item] }, (sock) => sock.sub.instructionId === s.instructionId);
    return item;
  }

  addTask(rec: InstRec, o: { key: string; title: string; spec: string; assignee: Agent; paths: string[]; round?: number; status?: Task["status"] }): Task {
    const now = this.now();
    const t: Task = {
      id: uuid(),
      instructionId: rec.summary.id,
      parentTaskId: null,
      assigneeAgentId: o.assignee.id,
      kind: "work",
      planKey: o.key,
      dependsOn: [],
      title: o.title,
      spec: o.spec,
      paths: o.paths,
      status: o.status ?? "pending",
      resultSummary: null,
      round: o.round ?? 1,
      seq: rec.tasks.length,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    rec.tasks.push(t);
    this.broadcast({ t: "task.upserted", task: t });
    return t;
  }

  setTask(rec: InstRec, t: Task, patch: Partial<Task>): Task {
    const idx = rec.tasks.findIndex((x) => x.id === t.id);
    const next = { ...rec.tasks[idx]!, ...patch, updatedAt: this.now() };
    rec.tasks[idx] = next;
    this.broadcast({ t: "task.upserted", task: next });
    this.touchInst(rec);
    return next;
  }

  addWorkspace(rec: InstRec, o: { purpose: Workspace["purpose"]; taskKey?: string; taskId?: string | null; round?: number }): Workspace {
    const p = this.project(rec.summary.projectId)!;
    const id8 = rec.summary.id.slice(0, 8);
    const name = o.purpose === "integration" ? "integration" : `${o.taskKey}-r${o.round ?? 1}`;
    const now = this.now();
    const w: Workspace = {
      id: uuid(),
      instructionId: rec.summary.id,
      projectId: p.id,
      purpose: o.purpose,
      taskId: o.taskId ?? null,
      parentId: o.purpose === "task" ? (rec.workspaces.find((x) => x.purpose === "integration")?.id ?? null) : null,
      kind: p.workspaceKind,
      repoPath: p.repoPath ?? `~/baton-data/projects/${p.slug}`,
      worktreePath: `~/baton-data/worktrees/${id8}/${p.slug}/${name}`,
      branch: `baton/${id8}/${name}`,
      baseRef: p.baseBranch ?? "main",
      baseSha: "4f1c2a9e0b7d",
      headSha: null,
      status: "active",
      diffStat: [],
      diffTruncated: false,
      error: null,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
    };
    rec.workspaces.push(w);
    this.broadcast({ t: "workspace.upserted", workspace: w });
    return w;
  }

  setWorkspace(rec: InstRec, w: Workspace, patch: Partial<Workspace>): Workspace {
    const idx = rec.workspaces.findIndex((x) => x.id === w.id);
    const next = { ...rec.workspaces[idx]!, ...patch, updatedAt: this.now() };
    rec.workspaces[idx] = next;
    this.broadcast({ t: "workspace.upserted", workspace: next });
    return next;
  }

  addArtifact(rec: InstRec, o: { path: string; title: string; preview: string; taskId?: string | null }): Artifact {
    const p = this.project(rec.summary.projectId);
    const a: Artifact = {
      id: uuid(),
      instructionId: rec.summary.id,
      taskId: o.taskId ?? null,
      projectSlug: p?.slug ?? null,
      relPath: o.path,
      title: o.title,
      mime: o.path.endsWith(".md") ? "text/markdown" : "text/plain",
      sizeBytes: new TextEncoder().encode(o.preview).length,
      createdAt: this.now(),
      sha256: "0".repeat(64),
      previewText: o.preview,
    };
    rec.artifacts.push(a);
    const { sha256: _s, previewText: _p, ...meta } = a;
    this.broadcast({ t: "artifact.created", artifact: meta });
    return a;
  }

  // ───────────── メンバーの作業（偽 claude の台本に寄せた流れ） ─────────────

  /** 1 つのタスクをメンバーのセッションで進める。承認があれば CEO の回答を待つ */
  async runMember(
    rec: InstRec,
    o: {
      agent: Agent;
      taskKey: string;
      title: string;
      spec: string;
      paths: string[];
      round?: number;
      steps: MemberStep[];
      summary: string;
      artifacts?: { path: string; title: string; preview: string }[];
      /** この数のステップのあとで止まったままにする（スクリーンショット用） */
      haltAfter?: number;
    },
  ): Promise<void> {
    const key = rec.summary.id;
    const task = this.addTask(rec, { key: o.taskKey, title: o.title, spec: o.spec, assignee: o.agent, paths: o.paths, round: o.round });
    const ws = this.addWorkspace(rec, { purpose: "task", taskKey: o.taskKey, taskId: task.id, round: o.round });
    let s = this.addSession(rec, { role: "member", agentId: o.agent.id, title: `${o.agent.name} · ${o.title}`, taskId: task.id, workspaceId: ws.id });
    let t = this.setTask(rec, task, { status: "running", startedAt: this.now() });
    const cwd = ws.worktreePath;
    this.addItem(s, "system", { author: "system", summary: "開始", body: { model: "sonnet", cwd, permissionMode: "default", claudeCodeVersion: "2.1.303", toolsCount: 10, skills: o.agent.profile === "researcher" ? ["sns-url-research", "prior-art-search"] : [], mcpCount: 0 } });
    this.addItem(s, "user", { author: "runner", summary: o.spec.split("\n")[0]!.slice(0, 80), body: { text: `[タスク] ${o.title}\n${o.spec}\n触ってよい範囲: ${o.paths.join(", ")}` } });
    let turns = 1;
    for (const [i, step] of o.steps.entries()) {
      this.checkCancelled(key);
      if (o.haltAfter !== undefined && i >= o.haltAfter) await new Promise<never>(() => {});
      await this.sleep(900);
      this.checkCancelled(key);
      s = await this.waitIfPaused(rec, s);
      turns += 1;
      switch (step.kind) {
        case "think":
          s = this.setSession(rec, s, { activity: THINKING_ACTIVITY, activityAt: this.now(), turns });
          this.addItem(s, "thinking", { summary: "考え", body: { text: step.text } });
          break;
        case "todo":
          this.addItem(s, "tool_use", { toolName: "TodoWrite", toolUseId: uuid(), summary: "TODO を更新", body: { input: { todos: step.todos.map((x) => ({ ...x, activeForm: x.content })) } } });
          break;
        case "tool": {
          const id = uuid();
          s = this.setSession(rec, s, { activity: step.activity, activityAt: this.now(), turns });
          this.addItem(s, "tool_use", { toolName: step.tool, toolUseId: id, summary: step.summary, body: { input: step.input } });
          await this.sleep(700);
          this.addItem(s, "tool_result", { toolName: step.tool, toolUseId: id, summary: step.resultSummary ?? step.result.split("\n")[0]!.slice(0, 80), body: step.tool === "Bash" ? { stdout: step.result, stderr: "" } : { text: step.result } });
          break;
        }
        case "write": {
          const id = uuid();
          s = this.setSession(rec, s, { activity: `書いている ${step.path}`, activityAt: this.now(), turns });
          this.addItem(s, "tool_use", { toolName: "Write", toolUseId: id, summary: `作成した ${step.path}`, body: { input: { file_path: `${cwd}/${step.path}`, content: step.content } } });
          await this.sleep(500);
          const lines = step.content.replace(/\n$/, "").split("\n");
          const patch = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
          this.addItem(s, "tool_result", { toolName: "Write", toolUseId: id, summary: `作成した ${step.path}（+${lines.length} −0）`, body: { filePath: step.path, type: "create", patch, added: lines.length, removed: 0 } });
          break;
        }
        case "edit": {
          const id = uuid();
          s = this.setSession(rec, s, { activity: `編集している ${step.path}`, activityAt: this.now(), turns });
          this.addItem(s, "tool_use", { toolName: "Edit", toolUseId: id, summary: `編集した ${step.path}`, body: { input: { file_path: `${cwd}/${step.path}` } } });
          await this.sleep(500);
          this.addItem(s, "tool_result", { toolName: "Edit", toolUseId: id, summary: `編集した ${step.path}（+${step.added} −${step.removed}）`, body: { filePath: step.path, type: "edit", patch: step.patch.join("\n"), added: step.added, removed: step.removed } });
          break;
        }
        case "text":
          s = this.setSession(rec, s, { activity: THINKING_ACTIVITY, activityAt: this.now(), turns });
          this.addItem(s, "text", { summary: step.text.split("\n")[0]!.slice(0, 80), body: { text: step.text } });
          break;
        case "approval": {
          const toolUseId = uuid();
          this.addItem(s, "tool_use", { toolName: "Bash", toolUseId, summary: `実行した ${step.command}`, body: { input: { command: step.command } } });
          const decision = this.openDecision(rec, s, { kind: "approval", toolName: "Bash", toolInput: { command: step.command }, question: step.command });
          this.addItem(s, "approval", { author: "system", toolName: "Bash", toolUseId, summary: `承認待ち: Bash ${step.command}`, body: { decisionId: decision.id, toolName: "Bash", input: { command: step.command } } });
          s = this.setSession(rec, s, { status: "awaiting_approval", activity: `実行している ${step.command}`, activityAt: this.now() });
          const answer = await this.waitFor(decision.id);
          this.checkCancelled(key);
          s = this.setSession(rec, s, { status: "running" });
          if (answer.verdict === "allow") {
            s = this.setSession(rec, s, { activity: `実行している ${step.command}`, activityAt: this.now() });
            await this.sleep(1200);
            this.addItem(s, "tool_result", { toolName: "Bash", toolUseId, summary: "added 1 package, audited 214 packages in 2s", body: { stdout: "added 1 package, audited 214 packages in 2s\n\nfound 0 vulnerabilities", stderr: "" } });
          } else {
            this.addItem(s, "denied", { author: "system", toolName: "Bash", summary: `拒否: Bash ${step.command}`, body: { toolName: "Bash", reason: answer.answer ?? null } });
          }
          break;
        }
      }
      this.touchInst(rec);
    }
    await this.sleep(600);
    this.checkCancelled(key);
    for (const a of o.artifacts ?? []) this.addArtifact(rec, { ...a, taskId: task.id });
    this.addItem(s, "output", { summary: "結論", toolName: "StructuredOutput", body: { value: { kind: "done", summary: o.summary, artifacts: (o.artifacts ?? []).map((a) => ({ path: a.path, title: a.title })) } } });
    const durationMs = (o.steps.length * 900 + 1800) * 18;
    this.addItem(s, "result", { author: "system", summary: "終了", body: { subtype: "success", numTurns: turns + 1, durationMs, costUsdEst: 0.18 + o.steps.length * 0.05, terminalReason: "completed", permissionDenials: [] } });
    s = this.setSession(rec, s, { status: "done", activity: null, endedAt: this.now(), turns: turns + 1, costUsdEst: 0.18 + o.steps.length * 0.05 });
    t = this.setTask(rec, t, { status: "done", resultSummary: o.summary, finishedAt: this.now() });
    const files = (o.artifacts ?? []).map((a) => ({ path: a.path, added: a.preview.split("\n").length, removed: 0, change: "A" as const }));
    this.setWorkspace(rec, ws, { status: "merged", diffStat: files, headSha: "9e2b7c1d4a30" });
    const integ = rec.workspaces.find((w) => w.purpose === "integration");
    if (integ) {
      const merged = [...integ.diffStat.filter((d) => !files.some((f) => f.path === d.path)), ...files];
      this.setWorkspace(rec, integ, { diffStat: merged, headSha: uuid().slice(0, 12) });
      rec.patch = buildPatch(rec.artifacts);
    }
  }

  /** 中断（paused）されていたら、CEO の「再開」を待つ */
  private async waitIfPaused(rec: InstRec, s: AgentSessionSummary): Promise<AgentSessionSummary> {
    const cur = rec.sessions.find((x) => x.id === s.id) ?? s;
    if (cur.status !== "paused") return cur;
    const d = rec.decisions.find((x) => x.sessionId === s.id && x.status === "open" && x.kind === "interrupted");
    if (d) await this.waitFor(d.id);
    const next = this.setSession(rec, cur, { status: "running", pauseReason: null });
    this.addItem(next, "system", { author: "runner", summary: "再開", body: {} });
    return next;
  }

  openDecision(rec: InstRec, s: AgentSessionSummary, o: { kind: Decision["kind"]; toolName: string | null; toolInput: Record<string, unknown> | null; question: string }): Decision {
    const d: Decision = {
      id: uuid(),
      instructionId: rec.summary.id,
      taskId: s.taskId,
      askedByAgentId: s.agentId,
      kind: o.kind,
      sessionId: s.id,
      question: o.question,
      options: [],
      toolName: o.toolName,
      toolInput: o.toolInput,
      status: "open",
      answer: null,
      verdict: null,
      suggestion: null,
      suggestionVerdict: null,
      suggestionAt: null,
      answeredAt: null,
      createdAt: this.now(),
    };
    rec.decisions.push(d);
    this.broadcast({ t: "decision.upserted", decision: d });
    this.touchInst(rec);
    return d;
  }

  waitFor(decisionId: string): Promise<{ verdict?: "allow" | "deny"; answer?: string }> {
    return new Promise((resolve) => this.waiters.set(decisionId, resolve));
  }

  // ───────────── 組み立て（REST の応答） ─────────────

  detail(rec: InstRec): InstructionDetail {
    const p = this.project(rec.summary.projectId);
    const coo = this.threads.get(COO_THREAD_ID)!;
    return {
      instruction: { ...rec.summary, feedback: rec.feedback, attempt: rec.attempt, originThreadId: rec.originThreadId, finalizedAt: rec.finalizedAt },
      project: p,
      tasks: rec.tasks,
      decisions: rec.decisions,
      openDecisions: rec.decisions.filter((d) => d.status === "open"),
      artifacts: rec.artifacts.map(({ sha256: _s, previewText: _p, ...m }) => m),
      sessions: rec.sessions,
      workspaces: rec.workspaces,
      originMessage: rec.originMessageId ? (coo.messages.find((m) => m.id === rec.originMessageId) ?? null) : null,
      cooThreadId: COO_THREAD_ID,
      leaderThreadId: p ? this.leaderThreadId(p) : null,
    };
  }

  sidebar(): SidebarOutput {
    const now = this.now();
    const items = this.projects
      .filter((p) => p.status === "active")
      .map((p) => {
        const recs = [...this.insts.values()].filter((r) => r.summary.projectId === p.id);
        const counts = countInstructions(
          recs.map((r) => r.summary),
          now,
        );
        const running = recs.flatMap((r) => r.sessions.filter((s) => s.status === "running" || s.status === "awaiting_approval"));
        const latest = [...running].sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0))[0];
        const lastActivityAt = Math.max(0, ...recs.map((r) => r.summary.updatedAt), ...running.map((s) => s.activityAt ?? 0)) || null;
        return {
          project: p,
          counts,
          leaderThread: this.threadView(this.threads.get(this.leaderThreadId(p))!),
          activeAgents: new Set(running.map((s) => s.agentId)).size,
          activity: latest?.activity ?? null,
          lastActivityAt,
          inProgress: isProjectInProgress(counts),
        };
      })
      .sort(compareSidebarProjects);
    const approvals = [...this.insts.values()].reduce((n, r) => n + r.decisions.filter((d) => d.status === "open" && d.kind === "approval").length, 0);
    return { items, approvals };
  }

  private agentLive(agent: Agent, threadId: string | null): AgentLive {
    const sessions = [...this.insts.values()].flatMap((r) => r.sessions.filter((s) => s.agentId === agent.id).map((s) => ({ s, r })));
    const thread = threadId ? this.threads.get(threadId) : undefined;
    const hasOpen = [...this.insts.values()].some((r) => r.decisions.some((d) => d.status === "open" && d.kind !== "approval" && d.askedByAgentId === agent.id));
    const state = deriveAgentState({
      sessionStatuses: sessions.map((x) => x.s.status),
      hasOpenDecision: hasOpen,
      threadStatus: thread?.summary.status ?? null,
      talkingWithCeo: thread?.summary.talkingWithCeo ?? false,
    });
    const live = sessions.filter((x) => ["running", "awaiting_approval", "paused", "quota_wait", "pending"].includes(x.s.status));
    const work: AgentLive["work"] = live.map((x) => ({ sessionId: x.s.id, instructionId: x.r.summary.id, title: x.r.summary.title ?? x.r.summary.body, activity: x.s.activity, since: x.s.startedAt ?? x.s.createdAt }));
    if (thread && thread.summary.status === "running" && work.length === 0) {
      work.push({ sessionId: `turn-${thread.summary.id}`, instructionId: null, title: thread.summary.agentName, activity: thread.summary.activity, since: this.now() });
    }
    const lastActiveAt = Math.max(0, ...sessions.map((x) => x.s.updatedAt), ...(thread ? thread.messages.map((m) => m.createdAt) : [])) || null;
    return { agent, state, threadId, work, lastActiveAt };
  }

  org(): OrgSnapshot {
    const cooAgent: Agent = { id: COO_AGENT_ID, projectId: null, role: "coo", name: "COO", specialty: "CEO の窓口。目的を固め、チームに仕事を振る", model: "opus", profile: "coo", active: true };
    const cooThread = this.threadView(this.threads.get(COO_THREAD_ID)!);
    const now = this.now();
    return {
      coo: { ...this.agentLive(cooAgent, COO_THREAD_ID), thread: cooThread },
      projects: this.projects
        .filter((p) => p.status === "active")
        .map((p) => ({
          project: p,
          counts: countInstructions(
            [...this.insts.values()].filter((r) => r.summary.projectId === p.id).map((r) => r.summary),
            now,
          ),
          leader: this.agentLive(this.leaderOf(p), this.leaderThreadId(p)),
          members: p.agents.filter((a) => a.role === "member").map((a) => this.agentLive(a, null)),
        })),
      quota: this.quota,
      runner: this.runner,
    };
  }

  diff(rec: InstRec): WorkspaceDiff {
    const integ = rec.workspaces.find((w) => w.purpose === "integration") ?? null;
    return { workspace: integ, files: integ?.diffStat ?? [], patch: rec.patch, truncated: false, reviewSummary: rec.reviewSummary };
  }

  session(): SessionInfo {
    return {
      user: { id: "user-1", email: "r.hiromatsu.work@gmail.com", name: "Riku Hiromatsu", pictureUrl: null },
      csrfToken: this.csrf,
      runner: this.runner,
      env: "development",
      vapidPublicKey: this.vapidPublicKey,
    };
  }

  // ───────────── 擬似 WebSocket ─────────────

  createSocket = (_url: string): SocketLike => {
    const s = new MockSocket(this);
    this.sockets.add(s);
    return s;
  };

  helloFor(): ServerEvent {
    return { t: "hello", serverTime: this.now(), runner: this.runner };
  }

  // ───────────── 以下は台本（script.ts）と REST（rest.ts）が埋める ─────────────

  /** CEO の発言を受けたときの台本 */
  onCeoMessage: (threadId: string, msg: ThreadMessage) => void = () => {};
  onTransition: (rec: InstRec, action: CeoAction, comment: string | undefined) => void = () => {};
  onAcceptProposal: (proposal: ProjectProposal, project: ProjectWithTeam) => void = () => {};
  onDeclineProposal: (proposal: ProjectProposal) => void = () => {};
  onFollowup: (rec: InstRec, session: AgentSessionSummary, input: SessionInput) => void = () => {};

  /** 中断（スレッド） */
  interruptThread(threadId: string): void {
    const rec = this.threads.get(threadId);
    if (rec?.summary.status === "running") this.cancelled.add(`thread:${threadId}`);
  }

  /** 取消（指示）。メンバーの流れを止める */
  cancelInstruction(id: string): void {
    this.cancelled.add(id);
    const rec = this.insts.get(id);
    if (!rec) return;
    for (const s of rec.sessions) if (["running", "awaiting_approval", "pending", "paused"].includes(s.status)) this.setSession(rec, s, { status: "canceled", activity: null, endedAt: this.now() });
    for (const d of rec.decisions) if (d.status === "open") this.resolveDecision(rec, d, { status: "canceled" });
  }

  resumeInstruction(id: string): void {
    this.cancelled.delete(id);
  }

  resolveDecision(rec: InstRec, d: Decision, patch: Partial<Decision>): Decision {
    const idx = rec.decisions.findIndex((x) => x.id === d.id);
    const next = { ...rec.decisions[idx]!, ...patch, answeredAt: this.now() };
    rec.decisions[idx] = next;
    this.broadcast({ t: "decision.upserted", decision: next });
    return next;
  }

  answer(decisionId: string, body: { verdict?: "allow" | "deny"; answer?: string }): { decision: Decision; instruction: InstructionSummary } | null {
    for (const rec of this.insts.values()) {
      const d = rec.decisions.find((x) => x.id === decisionId);
      if (!d) continue;
      if (d.status !== "open") return null;
      const next = this.resolveDecision(rec, d, { status: "answered", verdict: body.verdict ?? null, answer: body.answer ?? null });
      const waiter = this.waiters.get(decisionId);
      this.waiters.delete(decisionId);
      if (rec.summary.status === "needs_decision") this.setInst(rec, { status: "running" });
      else this.touchInst(rec);
      waiter?.(body);
      return { decision: next, instruction: rec.summary };
    }
    return null;
  }

  recordTransition(rec: InstRec, action: CeoAction, from: InstructionStatus, to: InstructionStatus): TransitionLog {
    const log: TransitionLog = { id: uuid(), instructionId: rec.summary.id, from, to, at: this.now(), undone: false, action };
    this.transitions.push(log);
    return log;
  }

  get listDelay(): number {
    return this.listDelayMs;
  }

  /** CSRF・ログインの検査つきで REST を処理する（rest.ts が差し込む） */
  handle: (method: string, path: string, query: URLSearchParams, body: Record<string, unknown>) => Response | Promise<Response> = () => error(404, "not_found", "not found");

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    await Promise.resolve();
    await this.ready;
    if (path === API_PATHS.session) {
      if (!this.loggedIn) return error(401, "unauthorized", "unauthorized");
      return json(200, this.session());
    }
    if (!this.loggedIn) return error(401, "unauthorized", "unauthorized");
    if (method !== "GET") {
      const h = new Headers(init.headers);
      if (h.get("X-Baton-CSRF") !== this.csrf) return error(403, "forbidden", "csrf");
    }
    let body: Record<string, unknown> = {};
    if (typeof init.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return error(400, "invalid", "json");
      }
    }
    return this.handle(method, path, url.searchParams, body);
  };
}

class Cancelled extends Error {}

/** 成果物から統合用の差分（unified）を作る */
export function buildPatch(artifacts: readonly Artifact[]): string {
  return artifacts
    .map((a) => {
      const lines = (a.previewText ?? "").replace(/\n$/, "").split("\n");
      return [
        `diff --git a/${a.relPath} b/${a.relPath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${a.relPath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n");
    })
    .join("\n");
}

export class MockSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sub: { threadId: string | null; instructionId: string | null } = { threadId: null, instructionId: null };
  visible = true;
  private readonly backend: MockBackend;

  constructor(backend: MockBackend) {
    this.backend = backend;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.deliver(backend.helloFor());
    }, 30);
  }

  deliver(ev: ServerEvent): void {
    if (this.readyState !== 1) return;
    const data = JSON.stringify(ev);
    setTimeout(() => this.onmessage?.(new MessageEvent("message", { data })), 0);
  }

  send(data: string): void {
    if (data === "ping") {
      setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: "pong" })), 0);
      return;
    }
    try {
      const msg = JSON.parse(data) as { t?: string; threadId?: string; instructionId?: string; visible?: boolean };
      if (msg.t === "subscribe") this.sub = { threadId: msg.threadId ?? null, instructionId: msg.instructionId ?? null };
      else if (msg.t === "unsubscribe") this.sub = { threadId: null, instructionId: null };
      else if (msg.t === "presence") this.visible = msg.visible !== false;
    } catch {
      // 無視
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.backend.sockets.delete(this);
    this.onclose?.(new CloseEvent("close"));
  }
}

export const BOT_SCOPE_LIST: readonly BotScope[] = ["read", "message", "propose"];
