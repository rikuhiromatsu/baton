// スレッド（COO・リーダー）の 1 ターン（DESIGN-v2 4.5〜4.7・5.3・5.8）。
// 受信箱の未処理をまとめて 1 ターン。返事は文章（ストリーミング）、行動は StructuredOutput（CooTurn・LeaderTurn）。
// スキーマ違反・error_* は 1 回だけやり直し、2 回目も失敗したら notice「うまく返事ができませんでした」で受信箱は消化済み。
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  COO_THREAD_ID,
  TURN_TAGS,
  UI_TEXT_V2,
  buildThreadTurnInput,
  buildTurnInput,
  parseTurnOutput,
  type ClaimOutput,
  type InboxItem,
  type ProjectWithTeam,
  type ThreadTurnContext,
} from "@baton/shared";
import { AgentSession, type TurnOutcome } from "../claude/session.ts";
import { StreamSink } from "../claude/sink.ts";
import { dataPaths } from "../config.ts";
import type { RunnerContext } from "../context.ts";
import { ConflictError, errorMessage, StopSignal } from "../errors.ts";
import { projectRepo } from "../git/workspaces.ts";
import { executeCooActions, executeLeaderActions } from "./actions.ts";
import { clip, hhmm, roleSetup } from "./common.ts";

export type ThreadClaim = Extract<ClaimOutput, { kind: "thread" }>;

export type ThreadTurnResult = "done" | "released" | "failed" | "interrupted" | "skipped";

/** COO の作業フォルダの org.md（毎ターン書き直す。4.2） */
export function renderOrg(context: ThreadTurnContext): string {
  const lines: string[] = ["# 組織（Baton が毎ターン書き直す。読むだけ）", ""];
  lines.push("## プロジェクト");
  if (context.projects.length === 0) lines.push("- （まだ無い）");
  for (const p of context.projects) {
    const ws = p.workspaceKind === "repo" ? `既存リポジトリ ${p.repoName ?? p.repoPath ?? ""}` : "Baton 専用";
    lines.push(`- ${p.name}（${p.slug}・ID ${p.id}・${ws}）: ${p.goal || p.summary || "目的は未設定"}`);
    for (const a of p.agents.filter((a) => a.active)) lines.push(`  - ${a.role === "leader" ? "リーダー" : "メンバー"} ${a.name}${a.profile ? `（${a.profile}）` : ""}: ${a.specialty}`);
  }
  lines.push("", "## 開いている指示");
  if (context.openInstructions.length === 0) lines.push("- （無い）");
  for (const i of context.openInstructions) lines.push(`- ${i.id}「${i.title}」${i.status}${i.phase ? `・${i.phase}` : ""}・rev ${i.revision}${i.talkingWithCeo ? "・CEO とリーダーが話し中" : ""}`);
  lines.push("", "## 既存リポジトリの候補（propose_project の workspace.repoPath に使える）");
  if (context.repos.length === 0) lines.push("- （無い）");
  for (const r of context.repos) lines.push(`- ${r.path}（${r.name}${r.dirty ? "・作業中の変更あり" : ""}${r.projectId ? "・紐づけ済み" : ""}）`);
  return `${lines.join("\n")}\n`;
}

/** リーダーのチーム（plan の assignee に使う名前。実物で、知らないと COO に聞きに行った） */
export function teamText(project: ProjectWithTeam): string {
  const members = project.agents.filter((a) => a.active && a.role === "member");
  const leader = project.agents.find((a) => a.active && a.role === "leader");
  return [
    `## チーム（プロジェクト「${project.name}」）`,
    `- リーダー（あなた）: ${leader?.name ?? "リーダー"}`,
    ...members.map((m) => `- メンバー: ${m.name}（${m.profile ?? "generalist"}）${m.specialty ? `: ${m.specialty}` : ""}`),
    "plan の assignee には、上のメンバーの名前をそのまま書く。",
  ].join("\n");
}

function inboxEntries(inbox: readonly InboxItem[]) {
  return inbox.map((i) => {
    // プロジェクトが立った知らせには ID を必ず入れる（COO が existing の delegate を出せるように）
    if (i.kind === "project_created") {
      const p = i.payload;
      const id = typeof p.projectId === "string" ? p.projectId : null;
      const text = typeof p.text === "string" ? p.text : "プロジェクトが立ちました";
      if (id && !text.includes(`id: ${id}`)) return { kind: i.kind, instructionId: i.instructionId, payload: { ...p, text: `${text}（id: ${id}）` } };
    }
    return { kind: i.kind, instructionId: i.instructionId, payload: i.payload };
  });
}

/** 新しいセッションへの引き継ぎ（4.2: 直近 30 件の発言と開いている指示） */
function handoffText(context: ThreadTurnContext, inbox: readonly InboxItem[]): string | null {
  const own = new Set(inbox.map((i) => i.messageId).filter(Boolean));
  const msgs = context.recentMessages.filter((m) => !own.has(m.id) && m.status !== "streaming" && m.body.trim()).slice(-30);
  if (msgs.length === 0) return null;
  const who = (k: string) => (k === "ceo" ? "CEO" : k === "coo" ? "COO" : k === "leader" ? "リーダー" : k === "secretary" ? "秘書" : "システム");
  return `これまでの会話（新しいセッションへの引き継ぎ）:\n${msgs.map((m) => `- ${who(m.authorKind)}: ${clip(m.body.replace(/\s+/g, " "), 300)}`).join("\n")}`;
}

export async function runThreadTurn(ctx: RunnerContext, claim: ThreadClaim, signal: AbortSignal): Promise<ThreadTurnResult> {
  const { thread, inbox, context } = claim;
  const role = thread.kind;
  const consumed = inbox.map((i) => i.id);
  const project: ProjectWithTeam | null = role === "leader" ? (context.projects.find((p) => p.id === thread.projectId) ?? null) : null;

  if (!ctx.auth.canStart) {
    await ctx.api.releaseThread(thread.id, { reason: "auth", notBefore: null, error: ctx.auth.tripped ?? "claude にサブスクでログインしていません" }).catch(() => undefined);
    return "released";
  }
  if (!ctx.quota.canStartThreadTurn()) {
    await ctx.api.releaseThread(thread.id, { reason: "quota", notBefore: ctx.quota.blockedUntil }).catch(() => undefined);
    return "released";
  }
  if (role === "leader" && !project) {
    ctx.log.warn("リーダーのスレッドのプロジェクトが見つかりません", { threadId: thread.id });
    await ctx.api.turnDone(thread.id, { consumedInboxIds: consumed, awaitingReply: false, ackMessageIds: [], sessionId: thread.currentSessionId ?? randomUUID(), numTurns: 0 });
    return "skipped";
  }

  // 依頼を受けたリーダーのターンが始まる: queued → running（4.4）。
  // 確認・完了の指示（COO の relay・差し戻し）は動かさない。やり直すならリーダーの plan が reopen する
  if (role === "leader") {
    for (const i of inbox) {
      const st = i.instructionId ? context.openInstructions.find((o) => o.id === i.instructionId)?.status : undefined;
      if (i.kind === "delegation" && i.instructionId && st !== "review" && st !== "done") {
        await ctx.api.patchInstruction(i.instructionId, { status: "running", phase: "leader" }).catch((err: unknown) => {
          if (!(err instanceof ConflictError)) ctx.log.warn("指示を running にできません", { instructionId: i.instructionId, error: errorMessage(err) });
        });
      }
    }
  }

  const hasCeo = inbox.some((i) => i.kind === "ceo_message");
  const secretary = inbox.some((i) => i.kind === "secretary_message");
  const turnInstructionId = inbox.find((i) => i.instructionId)?.instructionId ?? null;
  const paths = dataPaths(ctx.config);
  const cwd = role === "coo" ? paths.coo : paths.leader(project!.slug);
  await mkdir(cwd, { recursive: true });
  if (role === "coo") await writeFile(`${cwd}/org.md`, renderOrg(context));

  // セッション（4.2: num_turns が 400 を超えたら新しいセッション）
  let rotate = thread.currentSessionId === null || thread.sessionTurns >= ctx.config.limits.sessionTurnsBeforeRotate;
  let sessionId = rotate ? randomUUID() : thread.currentSessionId!;
  let session: AgentSession | null = rotate ? null : await ctx.threads.take(thread.id, sessionId);
  if (rotate) await ctx.threads.drop(thread.id);

  const launch = async (resume: boolean): Promise<AgentSession> => {
    if (!(await ctx.threads.reserve())) throw new Error("スレッドのプロセスの空きがありません");
    try {
      let repoDir: string | null = null;
      let addDirs: string[] = [];
      let denyWrite: string[] = [];
      if (role === "coo") {
        addDirs = [paths.projects, ...context.projects.filter((p) => p.workspaceKind === "repo" && p.repoPath).map((p) => p.repoPath!)];
        await mkdir(paths.projects, { recursive: true });
      } else {
        const body = await projectRepo(ctx, project!);
        await mkdir(paths.worktrees, { recursive: true });
        repoDir = project!.workspaceKind === "repo" ? body : null;
        addDirs = [body, paths.worktrees];
        denyWrite = [body, paths.worktrees, paths.projects];
      }
      const setup = await roleSetup(ctx, { role, project, repoDir, extra: role === "leader" ? teamText(project!) : null });
      if (!resume) {
        await ctx.api.createSession({
          id: sessionId,
          threadId: thread.id,
          instructionId: null,
          agentId: thread.agentId,
          role,
          projectId: thread.projectId,
          taskId: null,
          workspaceId: null,
          title: role === "coo" ? "COO" : clip(`リーダー · ${project!.name}`, 60),
          cwd,
          model: setup.model,
        });
      }
      // 続きのセッション（--resume）は新しいプロセスでもトランスクリプトの seq を続きから振る。
      // 0 から振り直すと、前のプロセスの項目と seq が重なって Worker に捨てられる（ON CONFLICT DO NOTHING）
      const startSeq = resume ? ((await ctx.api.patchSession(sessionId, { turnsDelta: 0 }).catch(() => null))?.lastSeq ?? 0) : 0;
      const s = new AgentSession(ctx, {
        role,
        sessionId,
        resume,
        startSeq,
        cwd,
        addDirs: [...new Set(addDirs)],
        model: setup.model,
        fallbackModel: setup.fallback,
        profileId: setup.profileId,
        profile: setup.profile,
        systemPrompt: setup.systemPrompt,
        threadId: thread.id,
        instructionId: null,
        taskId: null,
        agentId: thread.agentId,
        denyWrite,
        approvals: null,
      });
      await s.launch();
      await ctx.api.patchSession(sessionId, { status: "running", started: true }).catch(() => undefined);
      ctx.threads.put(thread.id, s);
      return s;
    } catch (err) {
      ctx.threads.unreserve();
      throw err;
    }
  };

  try {
    if (!session) session = await launch(!rotate);
    // 生きているプロセスで続けるターン: 前のターンの終わりに手すき（idle）にしたので running に戻す
    else await ctx.api.patchSession(sessionId, { status: "running" }).catch(() => undefined);
  } catch (err) {
    ctx.log.error("スレッドのセッションを起動できません", { threadId: thread.id, error: errorMessage(err) });
    await ctx.api.releaseThread(thread.id, { reason: "error", notBefore: ctx.now() + 60_000, error: errorMessage(err) }).catch(() => undefined);
    return "failed";
  }

  // 入力
  const entries = inboxEntries(inbox);
  const instructions = role === "leader" ? context.openInstructions.filter((i) => i.projectId === project!.id) : context.openInstructions;
  let text = buildThreadTurnInput({ threadKind: role, now: ctx.now(), viewing: context.viewing, inbox: entries, instructions });
  if (rotate) {
    const h = handoffText(context, inbox);
    if (h) text = `${buildTurnInput([{ tag: TURN_TAGS.context, text: h }])}\n${text}`;
  }

  // 入力中の印（空の発言）
  const notify = role === "coo" ? true : hasCeo;
  const messageId = randomUUID();
  await ctx.api.postMessage(thread.id, {
    id: messageId,
    authorKind: role,
    authorAgentId: thread.agentId,
    kind: "chat",
    body: "",
    instructionId: null,
    sessionId,
    ref: {},
    status: "streaming",
    notify,
  });
  const stream = new StreamSink({ api: ctx.api, flushMs: ctx.config.limits.streamFlushMs }, thread.id, messageId);

  const failMessage = async (notice: string) => {
    await ctx.api.patchMessage(thread.id, messageId, { delete: true }).catch(() => undefined);
    await ctx.api
      .postMessage(thread.id, { id: randomUUID(), authorKind: "system", authorAgentId: null, kind: "notice", body: notice, instructionId: turnInstructionId, sessionId, ref: {}, status: "complete", notify: false })
      .catch(() => undefined);
  };

  let outcome: TurnOutcome | null = null;
  let parsed: ReturnType<typeof parseTurnOutput<typeof role>> | null = null;
  let resumedFresh = false;
  let restarts = 0;
  for (let attempt = 0; ; attempt++) {
    const input =
      attempt === 0
        ? text
        : `${buildTurnInput([{ tag: TURN_TAGS.runner, text: `直前の出力がスキーマに合わなかった（${clip(parsed && !parsed.ok ? parsed.error : (outcome?.result?.subtype ?? "失敗"), 400)}）。次の入力にもう一度、返事の文章と StructuredOutput で答えて。` }])}\n${text}`;
    if (attempt > 0) stream.reset();
    outcome = await session.turn(input, { author: hasCeo && attempt === 0 ? "ceo" : "runner", stream, signal, instructionId: turnInstructionId });

    if (outcome.authViolation) {
      await failMessage(UI_TEXT_V2.conversation.failedReply);
      await ctx.threads.drop(thread.id);
      await ctx.api.patchSession(sessionId, { status: "failed", error: outcome.authViolation, ended: true }).catch(() => undefined);
      await ctx.api.releaseThread(thread.id, { reason: "auth", notBefore: null, error: outcome.authViolation }).catch(() => undefined);
      return "failed";
    }
    if (outcome.result?.limitHit || ctx.quota.current.status === "rejected") {
      const until = ctx.quota.blockedUntil ?? ctx.now() + 30 * 60_000;
      await ctx.api.patchMessage(thread.id, messageId, { status: "failed", body: stream.text }).catch(() => undefined);
      await ctx.api
        .postMessage(thread.id, { id: randomUUID(), authorKind: "system", authorAgentId: null, kind: "notice", body: `${UI_TEXT_V2.transcript.quotaHit}・${hhmm(until)}に戻る`, instructionId: null, sessionId, ref: { notice: "quota" }, status: "complete", notify: false })
        .catch(() => undefined);
      ctx.threads.idle(thread.id);
      await ctx.api.releaseThread(thread.id, { reason: "quota", notBefore: until }).catch(() => undefined);
      return "released";
    }
    if (signal.aborted || outcome.interrupted) {
      const reason = signal.reason instanceof StopSignal ? signal.reason.reason : "interrupt";
      await ctx.api.patchMessage(thread.id, messageId, { status: "canceled", body: stream.text || outcome.replyText }).catch(() => undefined);
      if (reason === "shutdown") {
        await ctx.threads.drop(thread.id, { interrupt: false });
        await ctx.api.releaseThread(thread.id, { reason: "shutdown", notBefore: null }).catch(() => undefined);
        return "released";
      }
      ctx.threads.idle(thread.id);
      await ctx.api.turnDone(thread.id, { consumedInboxIds: consumed, awaitingReply: false, ackMessageIds: [], sessionId, numTurns: outcome.result?.numTurns ?? 0 });
      return "interrupted";
    }
    if (!outcome.result) {
      // プロセスが result 無しで終わった。--resume に失敗したなら新しいセッションで 1 回だけやり直す
      ctx.log.warn("claude が result 無しで終わりました", { threadId: thread.id, sessionId, exit: outcome.exit, stderr: clip(outcome.stderr, 500) });
      await ctx.threads.drop(thread.id, { interrupt: false });
      if (!resumedFresh && !rotate) {
        resumedFresh = true;
        rotate = true;
        sessionId = randomUUID();
        const h = handoffText(context, inbox);
        if (h) text = `${buildTurnInput([{ tag: TURN_TAGS.context, text: h }])}\n${text}`;
        try {
          session = await launch(false);
        } catch (err) {
          await failMessage(UI_TEXT_V2.conversation.failedReply);
          await ctx.api.releaseThread(thread.id, { reason: "error", notBefore: ctx.now() + 60_000, error: errorMessage(err) }).catch(() => undefined);
          return "failed";
        }
        attempt = -1;
        continue;
      }
      if (restarts < ctx.config.limits.turnRetries) {
        // プロセスの起動し直しは attempt と別に数える（result の無い終わりが続いても無限に起動しない。Codex 指摘）
        restarts += 1;
        try {
          sessionId = randomUUID();
          rotate = true;
          session = await launch(false);
          attempt = -1;
          continue;
        } catch {
          // 下で失敗にする
        }
      }
      await failMessage(UI_TEXT_V2.conversation.failedReply);
      await ctx.api.turnDone(thread.id, { consumedInboxIds: consumed, awaitingReply: false, ackMessageIds: [], sessionId, numTurns: 0 });
      return "failed";
    }
    parsed = parseTurnOutput(role, outcome.structured);
    if (!outcome.result.isError && parsed.ok) break;
    if (attempt >= ctx.config.limits.turnRetries) {
      ctx.log.warn("ターンの出力が直りませんでした", { threadId: thread.id, error: parsed.ok ? outcome.result.subtype : parsed.error });
      await failMessage(UI_TEXT_V2.conversation.failedReply);
      ctx.threads.idle(thread.id);
      await ctx.api.turnDone(thread.id, { consumedInboxIds: consumed, awaitingReply: false, ackMessageIds: [], sessionId, numTurns: outcome.result.numTurns });
      return "failed";
    }
  }

  const value = parsed!.ok ? parsed!.value : null;
  const replyText = (outcome!.replyText.trim() || value?.reply?.trim() || "").slice(0, 32_000);
  let applied: { kind: "chat" | "report" | "project_proposal"; instructionId: string | null; ref: Record<string, unknown>; fallbackBody: string | null; acted: boolean };
  try {
    applied =
      role === "coo"
        ? await executeCooActions(ctx, { threadId: thread.id, messageId, agentId: thread.agentId, actions: (value as unknown as { actions: never[] }).actions, context, secretary, inbox })
        : await executeLeaderActions(ctx, { thread, project: project!, messageId, value: value as never, context, inbox, hasCeo });
  } catch (err) {
    ctx.log.error("行動の実行に失敗", { threadId: thread.id, error: errorMessage(err) });
    applied = { kind: "chat", instructionId: null, ref: {}, fallbackBody: null, acted: false };
  }
  const body = replyText || applied.fallbackBody || "";
  const ackMessageIds: string[] = [];
  if (!body) {
    // 本文が無い（相づちへの無言・行動だけ）。空の発言を消し、相づちなら既読を付ける（D-77）
    await ctx.api.patchMessage(thread.id, messageId, { delete: true }).catch(() => undefined);
    if (!applied.acted) for (const i of inbox) if (i.kind === "ceo_message" && i.messageId) ackMessageIds.push(i.messageId);
  } else {
    await ctx.api.patchMessage(thread.id, messageId, {
      body,
      status: "complete",
      kind: applied.kind,
      instructionId: applied.instructionId,
      ref: applied.ref,
    });
  }

  // 会話の区切り（4.6）は Worker が D1 の未報告から見つけて受信箱に入れる（離れたとき・最後の発言から BATON_CONVERSATION_BREAK_MS）
  if (role === "leader") {
    // 話し中で保留した COO の行動を見直させる（D-79）
    if (ctx.coord.heldProjects.has(project!.id) && !hasCeo) {
      ctx.coord.heldProjects.delete(project!.id);
      await ctx.api
        .pushInbox(COO_THREAD_ID, { kind: "instruction_event", wakes: true, payload: { text: `${project!.name} のリーダーの報告が出ました。保留していた報告・連絡は、[指示の状態] の版を見直してから行ってください` } })
        .catch(() => undefined);
    }
  }

  ctx.threads.idle(thread.id);
  await ctx.api.turnDone(thread.id, {
    consumedInboxIds: consumed,
    awaitingReply: value?.awaitingReply === true && body !== "",
    ackMessageIds,
    sessionId,
    numTurns: Math.max(0, Math.floor(outcome!.result!.numTurns)),
  });
  return "done";
}
