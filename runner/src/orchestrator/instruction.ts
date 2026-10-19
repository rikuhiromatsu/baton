// 指示のメンバーの段階（DESIGN-v2 5.4〜5.7・7.3〜7.6・9.2）。
// 依存が満たされたタスクからメンバーのセッションを起動（指示内 2 並列）。タスクごとに worktree、done のたびにコミットして統合用へマージ。
// ラウンドが全部終わったら差分・Codex レビュー（6.4）を添えてリーダーの受信箱に member_results。
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  TURN_TAGS,
  buildMemberTaskInput,
  buildTurnInput,
  parseTurnOutput,
  runnerEventItem,
  type AgentSessionSummary,
  type Agent,
  type ClaimOutput,
  type MemberOutput,
  type ProjectWithTeam,
  type Task,
  type Workspace,
} from "@baton/shared";
import { oneTimeRule } from "../claude/approval.ts";
import { AgentSession, type TurnOutcome } from "../claude/session.ts";
import type { RunnerContext } from "../context.ts";
import { ConflictError, LimitError, StopSignal, errorMessage } from "../errors.ts";
import { commitAll, diffSince, headSha, mergeBranch, mergeWithMarkers, removeWorktree } from "../git/git.ts";
import { createTaskWorktree, ensureIntegration, relInside, restoreWorktree, taskWorktreeName } from "../git/workspaces.ts";
import { dataPaths } from "../config.ts";
import { CONFLICT_SPEC_PREFIX } from "./actions.ts";
import { runCodexReview } from "./codex.ts";
import { clip, leaderThreadIdOf, roleSetup } from "./common.ts";

export type InstructionClaim = Extract<ClaimOutput, { kind: "instruction" }>;

type UnitResult =
  | { kind: "done"; taskId: string | null }
  | { kind: "failed"; taskId: string | null; reason: string }
  | { kind: "paused"; reason: "question" | "approval" | "interrupted" }
  | { kind: "quota" }
  | { kind: "auth"; reason: string }
  | { kind: "stopped" };

type Run = {
  ctx: RunnerContext;
  signal: AbortSignal;
  instruction: InstructionClaim["instruction"];
  project: ProjectWithTeam;
  integration: Workspace;
  tasks: Map<string, Task>;
  workspaces: Workspace[];
  sessions: AgentSessionSummary[];
  costUsd: number;
  approvals: number;
  /** このクレームでメンバーを動かした（ラウンドのまとめを出す） */
  worked: boolean;
  /** 上限などで全部のメンバーを止める */
  abortAll: (reason: StopSignal) => void;
};

const MEMBER_FINAL_STATUSES = new Set(["done", "failed", "canceled"]);

function memberOf(project: ProjectWithTeam, agentId: string | null): Agent | null {
  const members = project.agents.filter((a) => a.role === "member" && a.active);
  return members.find((m) => m.id === agentId) ?? members[0] ?? null;
}

function checkLimits(run: Run): void {
  const { ctx, instruction } = run;
  if (run.costUsd >= ctx.config.limits.instructionCostUsd) throw new LimitError(`推定額 ${run.costUsd.toFixed(2)} USD`);
  if (ctx.now() - instruction.createdAt > ctx.config.limits.instructionWallClockMs) throw new LimitError("経過時間");
}

export async function runInstructionPhase(ctx: RunnerContext, claim: InstructionClaim, signal: AbortSignal): Promise<string> {
  const { instruction, project } = claim;
  if (!ctx.auth.canStart) {
    await ctx.api.releaseInstruction(instruction.id, { reason: "auth", notBefore: null, error: ctx.auth.tripped ?? undefined }).catch(() => undefined);
    return "released";
  }
  const st = await ctx.state.instruction(instruction.id);
  const local = new AbortController();
  const outer = signal;
  signal = AbortSignal.any([outer, local.signal]);
  const run: Run = {
    ctx,
    signal,
    instruction,
    project,
    integration: null as unknown as Workspace,
    tasks: new Map(claim.tasks.map((t) => [t.id, t])),
    workspaces: [...claim.workspaces],
    sessions: claim.sessions,
    costUsd: Math.max(instruction.costUsdEst, claim.sessions.reduce((a, s) => a + s.costUsdEst, 0)),
    approvals: st.approvals,
    worked: false,
    abortAll: (r) => local.abort(r),
  };
  try {
    checkLimits(run);
    run.integration = await ensureIntegration(ctx, { instructionId: instruction.id, project, workspaces: run.workspaces });
    if (!run.workspaces.some((w) => w.id === run.integration.id)) run.workspaces.push(run.integration);
    const result = await runUnits(run);
    if (result === "released") return "released";
    if (signal.aborted) return "stopped";
    return await afterRound(run);
  } catch (err) {
    if (err instanceof LimitError) {
      await ctx.api.patchInstruction(instruction.id, { status: "failed", error: err.message }).catch(() => undefined);
      return "failed";
    }
    if (err instanceof StopSignal || signal.aborted) return "stopped";
    if (err instanceof ConflictError) return "lost";
    ctx.log.error("メンバーの段階で想定外のエラー", { instructionId: instruction.id, error: errorMessage(err) });
    await ctx.api.releaseInstruction(instruction.id, { reason: "error", notBefore: ctx.now() + 60_000, error: clip(errorMessage(err), 4000) }).catch(() => undefined);
    return "error";
  }
}

/** 再開すべきセッション（再起動・枠待ち・承認の答え・リーダーの答え・追加の依頼）と、起動すべきタスクを並列 2 で回す */
async function runUnits(run: Run): Promise<"ok" | "released"> {
  const { ctx, signal } = run;
  const started = new Set<string>();
  const handledSessions = new Set<string>();
  const running = new Set<Promise<void>>();
  let release: { reason: "quota" | "auth" | "shutdown"; error?: string } | null = null;
  let anyPaused = false;

  const nextUnit = async (): Promise<(() => Promise<UnitResult>) | null> => {
    // 1. 残ったセッション
    for (const s of run.sessions) {
      if (s.role !== "member" || handledSessions.has(s.id)) continue;
      handledSessions.add(s.id);
      const unit = await resumeUnit(run, s);
      if (unit) return unit;
    }
    // 2. 依存が満たされたタスク
    if (!ctx.quota.canStartMember()) return null;
    const all = [...run.tasks.values()];
    const doneKeys = new Set(all.filter((t) => t.status === "done" && t.planKey).map((t) => t.planKey!));
    const busyTasks = new Set(run.sessions.filter((s) => s.role === "member" && !MEMBER_FINAL_STATUSES.has(s.status) && s.taskId).map((s) => s.taskId!));
    const task = all
      .filter((t) => t.kind === "work" && t.status === "pending" && !started.has(t.id) && !busyTasks.has(t.id))
      .filter((t) => t.dependsOn.every((k) => doneKeys.has(k) || !all.some((x) => x.planKey === k)))
      .sort((a, b) => a.round - b.round || a.seq - b.seq)[0];
    if (!task) return null;
    started.add(task.id);
    return () => runTaskUnit(run, task);
  };

  const launchNext = async (): Promise<boolean> => {
    if (signal.aborted || release) return false;
    const unit = await nextUnit();
    if (!unit) return false;
    const p = (async () => {
      const releaseSlot = await ctx.memberSlots.acquire(signal);
      let r: UnitResult;
      try {
        checkLimits(run);
        run.worked = true;
        r = await unit();
      } catch (err) {
        if (err instanceof LimitError) throw err;
        r = signal.aborted ? { kind: "stopped" } : { kind: "failed", taskId: null, reason: errorMessage(err) };
        if (!signal.aborted) ctx.log.error("メンバーの作業で例外", { instructionId: run.instruction.id, error: errorMessage(err) });
      } finally {
        releaseSlot();
      }
      if (r.kind === "quota") release ??= { reason: "quota" };
      if (r.kind === "auth") release = { reason: "auth", error: r.reason };
      if (r.kind === "paused") anyPaused = true;
    })();
    const tracked: Promise<void> = p
      .catch((err: unknown) => {
        fatal ??= err;
        run.abortAll(new StopSignal("cancel"));
      })
      .finally(() => running.delete(tracked));
    running.add(tracked);
    return true;
  };

  let fatal: unknown = null;
  for (;;) {
    while (!fatal && running.size < ctx.config.limits.memberParallel && (await launchNext())) {
      // 空きがある限り起動
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  if (fatal) throw fatal;
  checkLimits(run);

  if (signal.aborted) return "released";
  if (release) {
    const r = release as { reason: "quota" | "auth" | "shutdown"; error?: string };
    await ctx.api
      .releaseInstruction(run.instruction.id, {
        reason: r.reason,
        notBefore: r.reason === "quota" ? (ctx.quota.blockedUntil ?? ctx.now() + 30 * 60_000) : null,
        ...(r.error ? { error: r.error } : {}),
      })
      .catch(() => undefined);
    return "released";
  }
  if (!ctx.quota.canStartMember() && [...run.tasks.values()].some((t) => t.kind === "work" && t.status === "pending")) {
    // しきい値を超えている間は新しいメンバーを起動しない（9.2）
    await ctx.api.releaseInstruction(run.instruction.id, { reason: "quota", notBefore: ctx.quota.blockedUntil ?? ctx.now() + 10 * 60_000 }).catch(() => undefined);
    return "released";
  }
  if (anyPaused) {
    const stillRunning = [...run.tasks.values()].some((t) => (t.status === "running" || t.status === "pending") && !pausedForDecision.has(t.id));
    const pausedForCeo = await hasOpenCeoDecision(run);
    if (pausedForCeo && !stillRunning) {
      // 承認の時間切れ・中断で止まり、他に動いているものが無い（4.4）
      await ctx.api.patchInstruction(run.instruction.id, { status: "needs_decision" }).catch(() => undefined);
    }
    return "released";
  }
  return "ok";
}

async function hasOpenCeoDecision(run: Run): Promise<boolean> {
  for (const s of run.sessions) {
    const st = await run.ctx.state.session(s.id);
    if (st?.pendingDecisionId) return true;
  }
  for (const id of pausedForDecision) if (run.tasks.has(id)) return true;
  return false;
}
/** このプロセスで承認の時間切れ・中断で止めたタスク */
const pausedForDecision = new Set<string>();

// ───────────── 1 つのタスク ─────────────

async function runTaskUnit(run: Run, task: Task): Promise<UnitResult> {
  const { ctx, project, instruction } = run;
  const agent = memberOf(project, task.assigneeAgentId);
  let ws = run.workspaces.find((w) => w.purpose === "task" && w.taskId === task.id && (w.status === "active" || w.status === "conflict"));
  if (ws) await restoreWorktree(ctx, ws, instruction.id);
  else {
    ws = await createTaskWorktree(ctx, {
      instructionId: instruction.id,
      project,
      integration: run.integration,
      taskId: task.id,
      name: taskWorktreeName(task.planKey, task.id, task.round),
    });
    run.workspaces.push(ws);
  }
  let conflictNote = "";
  if (task.spec.startsWith(CONFLICT_SPEC_PREFIX)) {
    const branch = task.spec.slice(CONFLICT_SPEC_PREFIX.length).split("\n")[0]!.trim();
    const files = await mergeWithMarkers({ repo: ws.repoPath, dir: ws.worktreePath, branch });
    conflictNote = files.length ? `\n衝突しているファイル: ${files.join(", ")}` : "";
  }
  const updated = await ctx.api.patchTask(task.id, { status: "running", assigneeAgentId: agent?.id ?? null });
  run.tasks.set(task.id, updated);

  const all = [...run.tasks.values()];
  const deps = task.dependsOn
    .map((k) => all.find((t) => t.planKey === k))
    .filter((t): t is Task => !!t)
    .map((t) => ({ taskKey: t.planKey ?? t.id, summary: t.resultSummary ?? "" }));
  const input = buildMemberTaskInput({
    title: task.title,
    spec: `${task.spec}${conflictNote}`,
    paths: task.paths,
    goal: project.goal,
    dependencyResults: deps,
    worktree: ws.worktreePath,
  });
  const sessionId = randomUUID();
  return driveMember(run, { task, ws, agent, sessionId, resume: false, input, createSession: true });
}

/** 残ったセッションの再開（7.5・7.6・9.2・5.6） */
async function resumeUnit(run: Run, s: AgentSessionSummary): Promise<(() => Promise<UnitResult>) | null> {
  const { ctx } = run;
  const task = s.taskId ? run.tasks.get(s.taskId) : undefined;
  const ws = run.workspaces.find((w) => w.id === s.workspaceId) ?? (task ? run.workspaces.find((w) => w.purpose === "task" && w.taskId === task.id) : undefined);
  if (!ws) return null;
  const agent = memberOf(run.project, s.agentId);
  const st = await ctx.state.session(s.id);
  let input: string | null = null;
  let oneTimeAllow: string[] = [];

  // 追加の依頼（CEO がメンバーのトランスクリプトから送る。5.6）
  const pending = await ctx.api.pendingInputs(s.id).catch(() => []);
  const followUps = pending.filter((p) => p.status === "pending");

  if (s.status === "running" || s.status === "awaiting_approval" || s.status === "pending") {
    input = buildTurnInput([{ tag: TURN_TAGS.runner, text: "ランナーが再起動した。直前の作業の結果を確かめてから続けて" }]);
  } else if (s.status === "quota_wait") {
    if (!ctx.quota.canStartThreadTurn()) return null;
    input = buildTurnInput([{ tag: TURN_TAGS.runner, text: "枠が戻った。続けて" }]);
  } else if (s.status === "paused") {
    if (s.pauseReason === "question") {
      if (!st?.pendingAnswer) return null;
      input = buildTurnInput([{ tag: TURN_TAGS.leader, text: st.pendingAnswer }]);
      await ctx.state.patchSession(s.id, { cwd: ws.worktreePath, pendingAnswer: null });
    } else {
      if (!st?.pendingDecisionId) return null;
      const d = await ctx.api.getDecision(st.pendingDecisionId).catch(() => null);
      if (!d || d.status === "open") return null;
      if (d.status === "canceled") return null;
      if (d.verdict === "deny") {
        input = buildTurnInput([{ tag: TURN_TAGS.ceoAnswer, text: `拒否された${d.answer ? `（${d.answer}）` : ""}。その操作をせずに、別の方法で続けて` }]);
      } else {
        const rule = st.pendingTool ? oneTimeRule(st.pendingTool.toolName, st.pendingTool.toolInput) : null;
        if (rule) oneTimeAllow = [rule];
        input = buildTurnInput([{ tag: TURN_TAGS.ceoAnswer, text: st.pendingTool ? `CEO が許可した。続けて${d.answer ? `（${d.answer}）` : ""}` : `再開して${d.answer ? `: ${d.answer}` : ""}` }]);
      }
      await ctx.state.patchSession(s.id, { cwd: ws.worktreePath, pendingDecisionId: null, pendingTool: null });
      if (task) pausedForDecision.delete(task.id);
    }
  } else if ((s.status === "done" || s.status === "idle" || s.status === "failed") && followUps.length > 0) {
    input = null; // 下で追加の依頼を入れる
  } else {
    return null;
  }
  if (followUps.length) {
    const extra = buildTurnInput(followUps.map((f) => ({ tag: TURN_TAGS.ceoFollowUp, text: f.body })));
    input = input ? `${input}\n${extra}` : extra;
    for (const f of followUps) await ctx.api.inputDelivered(f.id).catch(() => undefined);
  }
  if (!input) return null;
  const finalInput = input;
  const followUpOnly = s.status === "done" || s.status === "idle" || s.status === "failed";
  return async () => {
    await restoreWorktree(ctx, ws, run.instruction.id);
    if (task && task.status !== "running" && !followUpOnly) run.tasks.set(task.id, await ctx.api.patchTask(task.id, { status: "running" }));
    return driveMember(run, { task: task ?? null, ws, agent, sessionId: s.id, resume: true, input: finalInput, createSession: false, oneTimeAllow, followUpOnly, startSeq: s.lastSeq });
  };
}

// ───────────── セッションを回す ─────────────

async function driveMember(
  run: Run,
  input: {
    task: Task | null;
    ws: Workspace;
    agent: Agent | null;
    sessionId: string;
    resume: boolean;
    input: string;
    createSession: boolean;
    oneTimeAllow?: string[];
    followUpOnly?: boolean;
    startSeq?: number;
  },
): Promise<UnitResult> {
  const { ctx, project, instruction, signal } = run;
  const { task, ws, agent } = input;
  const setup = await roleSetup(ctx, { role: "member", agentProfile: agent?.profile ?? null, project, repoDir: project.workspaceKind === "repo" ? ws.worktreePath : null });
  if (input.createSession) {
    await ctx.api.createSession({
      id: input.sessionId,
      threadId: null,
      instructionId: instruction.id,
      agentId: agent?.id ?? null,
      role: "member",
      projectId: project.id,
      taskId: task?.id ?? null,
      workspaceId: ws.id,
      title: clip(task?.title ?? "追加の依頼", 60),
      cwd: ws.worktreePath,
      model: setup.model,
    });
  }
  await ctx.state.patchSession(input.sessionId, { instructionId: instruction.id, taskId: task?.id ?? null, workspaceId: ws.id, cwd: ws.worktreePath });

  let sessionId = input.sessionId;
  let resume = input.resume;
  let text = input.input;
  let triedFresh = !input.resume;
  const makeSession = () =>
    new AgentSession(ctx, {
      role: "member",
      sessionId,
      resume,
      cwd: ws.worktreePath,
      addDirs: [],
      model: setup.model,
      fallbackModel: setup.fallback,
      profileId: setup.profileId,
      profile: setup.profile,
      systemPrompt: setup.systemPrompt,
      threadId: null,
      instructionId: instruction.id,
      taskId: task?.id ?? null,
      agentId: agent?.id ?? null,
      oneTimeAllow: input.oneTimeAllow ?? [],
      startSeq: input.startSeq ?? 0,
      approvals: {
        instructionId: instruction.id,
        count: () => run.approvals,
        bump: () => {
          run.approvals += 1;
          void ctx.state.patchInstruction(instruction.id, { approvals: run.approvals });
        },
      },
      onApprovalState: (waiting) => void ctx.api.patchSession(sessionId, { status: waiting ? "awaiting_approval" : "running", ...(waiting ? { pauseReason: "approval" } : { pauseReason: null }) }).catch(() => undefined),
    });

  let session = makeSession();
  await session.launch();
  await ctx.api.patchSession(sessionId, { status: "running", pauseReason: null, started: true, error: null }).catch(() => undefined);
  if (resume) session.sink.add(runnerEventItem("再開"));
  const register = () =>
    ctx.coord.memberSessions.set(sessionId, {
      instructionId: instruction.id,
      inject: (t) => session.inject(buildTurnInput([{ tag: TURN_TAGS.ceoFollowUp, text: t }]), "ceo"),
      interrupt: () => session.interruptTurn(),
    });
  register();

  const end = async (status: "done" | "failed" | "canceled" | "paused" | "quota_wait", extra: { pauseReason?: "question" | "approval" | "interrupted"; error?: string } = {}) => {
    ctx.coord.memberSessions.delete(sessionId);
    await session.close({ interrupt: status === "canceled" });
    await ctx.api
      .patchSession(sessionId, {
        status,
        activity: null,
        ...(extra.pauseReason ? { pauseReason: extra.pauseReason } : {}),
        ...(extra.error ? { error: clip(extra.error, 4000) } : {}),
        ...(status === "done" || status === "failed" || status === "canceled" ? { ended: true } : {}),
      })
      .catch(() => undefined);
  };

  let retries = 0;
  try {
    for (;;) {
      const outcome: TurnOutcome = await session.turn(text, { signal, author: "runner" });
      if (outcome.result) run.costUsd += outcome.result.costUsdEst;
      if (outcome.authViolation) {
        await end("failed", { error: outcome.authViolation });
        return { kind: "auth", reason: outcome.authViolation };
      }
      if (outcome.result?.limitHit || ctx.quota.current.status === "rejected") {
        session.sink.add(runnerEventItem("枠待ち"));
        await end("quota_wait");
        return { kind: "quota" };
      }
      if (signal.aborted) {
        const reason = signal.reason instanceof StopSignal ? signal.reason.reason : "cancel";
        ctx.coord.memberSessions.delete(sessionId);
        if (reason === "shutdown") {
          // 再起動で --resume する（7.5）
          await session.close({ interrupt: true });
          return { kind: "stopped" };
        }
        await end("canceled");
        if (task) run.tasks.set(task.id, await ctx.api.patchTask(task.id, { status: "canceled" }).catch(() => task));
        return { kind: "stopped" };
      }
      if (outcome.approvalTimeout) {
        const at = outcome.approvalTimeout;
        const d = await ctx.api.createDecision({
          instructionId: instruction.id,
          sessionId,
          taskId: task?.id ?? null,
          askedByAgentId: agent?.id ?? null,
          kind: "interrupted",
          question: clip(`承認の返事が無かったので止めました。${at.toolName} を許可して再開しますか`, 1000),
          options: [],
          fromApprovalId: at.approvalId,
        });
        await ctx.state.patchSession(sessionId, { cwd: ws.worktreePath, pendingDecisionId: d.id, pendingTool: { toolName: at.toolName, toolInput: at.toolInput } });
        if (task) pausedForDecision.add(task.id);
        await end("paused", { pauseReason: "approval" });
        return { kind: "paused", reason: "approval" };
      }
      if (outcome.interrupted) {
        // CEO の中断（5.7）: paused（interrupted）で「再開」を出す
        const d = await ctx.api.createDecision({
          instructionId: instruction.id,
          sessionId,
          taskId: task?.id ?? null,
          askedByAgentId: agent?.id ?? null,
          kind: "interrupted",
          question: "中断しました。再開しますか",
          options: [],
        });
        await ctx.state.patchSession(sessionId, { cwd: ws.worktreePath, pendingDecisionId: d.id, pendingTool: null });
        if (task) pausedForDecision.add(task.id);
        await end("paused", { pauseReason: "interrupted" });
        return { kind: "paused", reason: "interrupted" };
      }
      if (!outcome.result) {
        ctx.log.warn("メンバーの claude が result 無しで終わりました", { sessionId, exit: outcome.exit, stderr: clip(outcome.stderr, 500) });
        ctx.coord.memberSessions.delete(sessionId);
        await session.close({ interrupt: false });
        if (!triedFresh) {
          // --resume できなければ新しいセッションに「前任の変更が残っている」（7.5）
          triedFresh = true;
          await ctx.api.patchSession(sessionId, { status: "failed", error: "再開できませんでした", ended: true }).catch(() => undefined);
          sessionId = randomUUID();
          resume = false;
          await ctx.api.createSession({
            id: sessionId,
            threadId: null,
            instructionId: instruction.id,
            agentId: agent?.id ?? null,
            role: "member",
            projectId: project.id,
            taskId: task?.id ?? null,
            workspaceId: ws.id,
            title: clip(task?.title ?? "追加の依頼", 60),
            cwd: ws.worktreePath,
            model: setup.model,
          });
          text = `${buildTurnInput([{ tag: TURN_TAGS.runner, text: "前任の変更が残っている。git status で確かめて続けて" }])}\n${task ? buildMemberTaskInput({ title: task.title, spec: task.spec, paths: task.paths, goal: project.goal, dependencyResults: [], worktree: ws.worktreePath }) : text}`;
          session = makeSession();
          await session.launch();
          await ctx.api.patchSession(sessionId, { status: "running", started: true }).catch(() => undefined);
          register();
          continue;
        }
        await end("failed", { error: clip(outcome.stderr || "claude が終了しました", 4000) });
        return finishFailed(run, task, "claude が途中で終了しました");
      }
      const parsed = parseTurnOutput("member", outcome.structured);
      if (outcome.result.isError || !parsed.ok) {
        if (retries < ctx.config.limits.turnRetries) {
          retries += 1;
          text = buildTurnInput([{ tag: TURN_TAGS.runner, text: `直前の出力がスキーマに合わなかった（${clip(parsed.ok ? outcome.result.subtype : parsed.error, 400)}）。作業を確かめて、もう一度 StructuredOutput を出して。` }]);
          continue;
        }
        await end("failed", { error: parsed.ok ? outcome.result.subtype : parsed.error });
        return finishFailed(run, task, parsed.ok ? `失敗（${outcome.result.subtype}）` : "結論の形が合いませんでした");
      }
      retries = 0;
      const out: MemberOutput = parsed.value;
      if (out.kind === "ask_leader") {
        // セッションを paused、リーダーの受信箱に member_question（5.6）。答えが来たらそのまま続ける
        await ctx.api.patchSession(sessionId, { status: "paused", pauseReason: "question" }).catch(() => undefined);
        await ctx.api.pushInbox(leaderThreadIdOf(project.id), {
          kind: "member_question",
          wakes: true,
          instructionId: instruction.id,
          payload: { sessionId, assignee: agent?.name ?? "メンバー", question: out.question },
        });
        const answer = await waitAnswer(ctx, sessionId, signal);
        if (answer === null) {
          await end("paused", { pauseReason: "question" });
          return { kind: "paused", reason: "question" };
        }
        await ctx.api.patchSession(sessionId, { status: "running", pauseReason: null }).catch(() => undefined);
        text = buildTurnInput([{ tag: TURN_TAGS.leader, text: answer }]);
        continue;
      }
      if (out.kind === "give_up") {
        await end("done");
        return finishFailed(run, task, `諦めました: ${out.reason}`, sessionId);
      }
      // done
      const r = await finishDone(run, { task, ws, agent, session, summary: out.summary, artifacts: out.artifacts, followUpOnly: input.followUpOnly === true });
      await end("done");
      return r;
    }
  } catch (err) {
    ctx.coord.memberSessions.delete(sessionId);
    await session.close({ interrupt: true }).catch(() => undefined);
    if (signal.aborted) return { kind: "stopped" };
    throw err;
  }
}

async function waitAnswer(ctx: RunnerContext, sessionId: string, signal: AbortSignal): Promise<string | null> {
  const timeoutMs = ctx.config.limits.approvalWaitMs * 3;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctx.coord.memberAnswers.delete(sessionId);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      ctx.coord.memberAnswers.delete(sessionId);
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    ctx.coord.memberAnswers.set(sessionId, (text) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(text);
    });
  });
}

async function finishFailed(run: Run, task: Task | null, reason: string, _sessionId?: string): Promise<UnitResult> {
  if (task) run.tasks.set(task.id, await run.ctx.api.patchTask(task.id, { status: "failed", resultSummary: clip(reason, 4000) }).catch(() => ({ ...task, status: "failed" as const, resultSummary: reason })));
  return { kind: "failed", taskId: task?.id ?? null, reason };
}

/** done: コミット → 統合用へマージ（衝突は --abort してリーダーへ）→ 成果物（7.3・7.4） */
async function finishDone(
  run: Run,
  input: { task: Task | null; ws: Workspace; agent: Agent | null; session: AgentSession; summary: string; artifacts: { path: string; title: string }[]; followUpOnly: boolean },
): Promise<UnitResult> {
  const { ctx, instruction } = run;
  const { task, ws, agent, session } = input;
  const lockDelays = ctx.config.limits.gitLockRetryDelaysMs;
  const message = `${task?.title ?? "追加の依頼"}（${agent?.name ?? "メンバー"}）`;
  const sha = await commitAll({ repo: ws.repoPath, dir: ws.worktreePath, message, lockDelays });
  if (sha) session.sink.add(runnerEventItem("コミット", { sha, branch: ws.branch }, ws.branch));

  // 成果物は worktree を消す前に読む
  for (const a of input.artifacts.slice(0, 10)) {
    const rel = relInside(ws.worktreePath, a.path.startsWith("/") ? path.relative(ws.worktreePath, a.path) : a.path);
    if (!rel) continue;
    const abs = path.join(ws.worktreePath, rel);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    const buf = await readFile(abs);
    const text = buf.subarray(0, 65_536).toString("utf8");
    const isText = !text.includes("\u0000");
    await ctx.api
      .createArtifact({
        instructionId: instruction.id,
        taskId: task?.id ?? null,
        relPath: rel.slice(0, 500),
        title: clip(a.title || rel, 80),
        mime: /\.md$/i.test(rel) ? "text/markdown" : isText ? "text/plain" : "application/octet-stream",
        sizeBytes: st.size,
        sha256: createHash("sha256").update(buf).digest("hex"),
        previewText: isText ? text : null,
      })
      .catch((err: unknown) => ctx.log.warn("成果物を登録できません", { path: rel, error: errorMessage(err) }));
  }

  let summary = input.summary;
  const merge = await mergeBranch({ repo: ws.repoPath, dir: run.integration.worktreePath, branch: ws.branch, lockDelays });
  if (merge.ok) {
    session.sink.add(runnerEventItem("統合", { branch: ws.branch, sha: merge.sha }, ws.branch));
    await ctx.api.patchWorkspace(ws.id, { status: "merged", headSha: sha ?? (await headSha(ws.worktreePath).catch(() => null)) }).catch(() => undefined);
    await ctx.api.patchWorkspace(run.integration.id, { headSha: merge.sha }).catch(() => undefined);
    await removeWorktree({ repo: ws.repoPath, dir: ws.worktreePath, worktreesRoot: dataPaths(ctx.config).worktrees }).catch((err: unknown) =>
      ctx.log.warn("タスク用 worktree を消せません", { dir: ws.worktreePath, error: errorMessage(err) }),
    );
  } else {
    session.sink.add(runnerEventItem("衝突", { branch: ws.branch, files: merge.files }, merge.files.join(", ")));
    await ctx.api.patchWorkspace(ws.id, { status: "conflict", error: clip(`衝突: ${merge.files.join(", ")}`, 4000) }).catch(() => undefined);
    const key = task?.planKey ?? task?.id ?? ws.branch;
    const st = await ctx.state.instruction(instruction.id);
    await ctx.state.patchInstruction(instruction.id, { conflicts: { ...(st.conflicts ?? {}), [key]: ws.branch } });
    await ctx.api.pushInbox(leaderThreadIdOf(run.project.id), { kind: "merge_conflict", wakes: false, instructionId: instruction.id, payload: { taskKey: key, files: merge.files } });
    summary = `${summary}\n（統合で衝突: ${merge.files.join(", ")}）`;
  }
  if (task && !input.followUpOnly) {
    run.tasks.set(task.id, await ctx.api.patchTask(task.id, { status: "done", resultSummary: clip(summary, 4000) }).catch(() => ({ ...task, status: "done" as const, resultSummary: summary })));
  }
  if (input.followUpOnly) {
    // 追加の依頼の結果はそのタスクだけリーダーへ（5.6）
    await ctx.api.pushInbox(leaderThreadIdOf(run.project.id), {
      kind: "member_results",
      wakes: true,
      instructionId: instruction.id,
      payload: { results: [{ taskKey: task?.planKey ?? "追加", assignee: agent?.name ?? "メンバー", outcome: merge.ok ? "done" : "conflict", summary }] },
    });
  }
  return { kind: "done", taskId: task?.id ?? null };
}

// ───────────── ラウンドのまとめ ─────────────

async function afterRound(run: Run): Promise<string> {
  const { ctx, instruction, project } = run;
  const work = [...run.tasks.values()].filter((t) => t.kind === "work");
  if (work.some((t) => t.status === "pending" || t.status === "running")) return "partial";
  if (!run.worked) return "idle";
  const round = Math.max(1, ...work.map((t) => t.round));
  const latest = work.filter((t) => t.round === round);
  const anyDone = work.some((t) => t.status === "done");
  if (!anyDone && round >= ctx.config.limits.maxRounds) {
    await ctx.api.patchInstruction(instruction.id, { status: "failed", error: "メンバーの作業がすべて失敗しました" }).catch(() => undefined);
    return "failed";
  }
  // 統合用の差分（7.4 の 5）
  const diff = await diffSince(run.integration.worktreePath, run.integration.baseSha);
  await ctx.api
    .patchWorkspace(run.integration.id, {
      headSha: await headSha(run.integration.worktreePath),
      diffStat: diff.stat.slice(0, 2000),
      diffPatch: diff.patch,
      diffTruncated: diff.truncated,
    })
    .catch((err: unknown) => ctx.log.warn("差分を送れません", { error: errorMessage(err) }));
  const results = latest.map((t) => ({
    taskKey: t.planKey ?? t.id.slice(0, 8),
    assignee: memberOf(project, t.assigneeAgentId)?.name ?? "メンバー",
    outcome: t.status,
    summary: clip(t.resultSummary ?? "", 2000),
  }));
  const leaderThreadId = leaderThreadIdOf(project.id);
  // Codex レビュー（統合後に 1 回。6.4）
  const findings = await runCodexReview(ctx, { project, integration: run.integration, diff: diff.stat }).catch((err: unknown) => {
    ctx.log.warn("Codex レビューに失敗", { error: errorMessage(err) });
    return null;
  });
  if (findings) {
    await ctx.api.pushInbox(leaderThreadId, { kind: "review_findings", wakes: false, instructionId: instruction.id, payload: { text: findings } });
  }
  await ctx.api.pushInbox(leaderThreadId, {
    kind: "member_results",
    wakes: true,
    instructionId: instruction.id,
    payload: { results, diffStat: clip(diff.text, 4000) },
  });
  await ctx.api.patchInstruction(instruction.id, { phase: "leader" }).catch(() => undefined);
  return "round_done";
}
