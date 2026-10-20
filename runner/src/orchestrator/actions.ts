// COO とリーダーの行動をランナーが行う（DESIGN-v2 4.5・4.6、D-78・D-79・D-91）。
import { randomUUID } from "node:crypto";
import {
  COO_THREAD_ID,
  SECRETARY_BLOCKED_COO_ACTIONS,
  type CooAction,
  type InboxItem,
  type LeaderTurn,
  type ProjectWithTeam,
  type ThreadTurnContext,
} from "@baton/shared";
import type { RunnerContext } from "../context.ts";
import { ConflictError, StaleRevisionError, errorMessage } from "../errors.ts";
import { projectRepo } from "../git/workspaces.ts";
import type { ThreadClaim } from "./thread.ts";
import { clip, leaderThreadIdOf } from "./common.ts";

export type Applied = {
  kind: "chat" | "report" | "project_proposal";
  instructionId: string | null;
  ref: Record<string, unknown>;
  fallbackBody: string | null;
  /** 何か行動を行った（相づちではない） */
  acted: boolean;
};

const notice = (ctx: RunnerContext, threadId: string, text: string, instructionId: string | null = null, wakes = false) =>
  ctx.api.pushInbox(threadId, { kind: "instruction_event", wakes, instructionId, payload: { text } }).catch((err: unknown) => ctx.log.warn("受信箱に入れられません", { threadId, error: errorMessage(err) }));

async function postSystem(ctx: RunnerContext, threadId: string, kind: "delegation" | "notice", body: string, instructionId: string | null, ref: Record<string, unknown> = {}) {
  return ctx.api.postMessage(threadId, { id: randomUUID(), authorKind: "system", authorAgentId: null, kind, body: clip(body, 32_000), instructionId, sessionId: null, ref, status: "complete", notify: false });
}

/** リーダーへ COO の発言と受信箱（delegation） */
async function toLeader(ctx: RunnerContext, input: { leaderThreadId: string; cooAgentId: string | null; body: string; instructionId: string | null; kind: "delegation" | "chat" }) {
  const m = await ctx.api.postMessage(input.leaderThreadId, {
    id: randomUUID(),
    authorKind: "coo",
    authorAgentId: input.cooAgentId,
    kind: input.kind,
    body: clip(input.body, 32_000),
    instructionId: input.instructionId,
    sessionId: null,
    ref: {},
    status: "complete",
    notify: false,
  });
  await ctx.api.pushInbox(input.leaderThreadId, { kind: "delegation", wakes: true, messageId: m.id, instructionId: input.instructionId, payload: { body: input.body } });
}

export async function executeCooActions(
  ctx: RunnerContext,
  input: { threadId: string; messageId: string; agentId: string | null; actions: CooAction[]; context: ThreadTurnContext; secretary: boolean; inbox: readonly InboxItem[] },
): Promise<Applied> {
  const out: Applied = { kind: "chat", instructionId: null, ref: {}, fallbackBody: null, acted: false };
  const { context } = input;
  const talking = new Set(context.talkingProjectIds);
  for (const action of input.actions) {
    if (input.secretary && (SECRETARY_BLOCKED_COO_ACTIONS as readonly string[]).includes(action.type)) {
      // 秘書の発言で起きたターンでは行わない（11.5・D-91）。CEO への確認の発言だけを残す
      ctx.log.info("秘書の発言のターンなので行動を行いません", { type: action.type });
      continue;
    }
    try {
      switch (action.type) {
        case "propose_project": {
          const repoOk = action.workspace.kind === "repo" && context.repos.some((r) => r.path === (action.workspace as { repoPath: string }).repoPath);
          const proposal = await ctx.api.createProposal({
            id: randomUUID(),
            threadId: input.threadId,
            messageId: input.messageId,
            name: action.name,
            slug: action.slug,
            goal: action.goal,
            summary: action.summary,
            workspace: repoOk ? action.workspace : { kind: "baton" },
            leader: action.leader,
            members: action.members,
          });
          out.kind = "project_proposal";
          out.ref = { ...out.ref, proposalId: proposal.id };
          out.fallbackBody ??= `プロジェクト案: ${action.name}`;
          out.acted = true;
          break;
        }
        case "delegate": {
          let project: ProjectWithTeam | null = null;
          let leaderThreadId: string | null = null;
          const reuse = action.project.mode === "new" ? context.projects.find((p) => p.slug === (action.project as { slug: string }).slug && p.status === "active") : undefined;
          if (reuse) {
            // 同じ slug のプロジェクトが既にある（同じ依頼の 2 回目など）: それを使う
            project = reuse;
            leaderThreadId = leaderThreadIdOf(reuse.id);
          } else if (action.project.mode === "new") {
            const created = await ctx.api.createProject({
              name: action.project.name,
              slug: action.project.slug,
              goal: action.project.goal,
              summary: action.project.summary,
              leader: action.project.leader,
              members: action.project.members,
            });
            project = created.project;
            leaderThreadId = created.leaderThreadId;
            await projectRepo(ctx, project);
          } else {
            const id = action.project.projectId;
            project = context.projects.find((p) => p.id === id) ?? null;
            leaderThreadId = project ? leaderThreadIdOf(project.id) : null;
          }
          if (!project || !leaderThreadId) {
            await notice(ctx, COO_THREAD_ID, `delegate のプロジェクトが見つかりません（${action.project.mode === "existing" ? action.project.projectId : "new"}）`);
            break;
          }
          const instruction = await ctx.api.createInstruction({
            id: randomUUID(),
            title: action.title,
            body: action.brief,
            projectId: project.id,
            originThreadId: input.threadId,
            originMessageId: input.messageId,
            phase: "leader",
          });
          await postSystem(ctx, input.threadId, "delegation", action.title, instruction.id, { contextProjectId: project.id, threadId: leaderThreadId });
          await toLeader(ctx, { leaderThreadId, cooAgentId: input.agentId, body: action.brief, instructionId: instruction.id, kind: "delegation" });
          out.instructionId ??= instruction.id;
          out.acted = true;
          break;
        }
        case "relay":
        case "present": {
          const instr = context.openInstructions.find((i) => i.id === action.instructionId);
          if (!instr) {
            await notice(ctx, COO_THREAD_ID, `指示 ${action.instructionId.slice(0, 8)} は開いていません`);
            break;
          }
          if (instr.projectId && (talking.has(instr.projectId) || instr.talkingWithCeo)) {
            // 話し中の保留（D-79）。リーダーのターンが終わって報告が出てから見直す
            ctx.coord.heldProjects.add(instr.projectId);
            await notice(ctx, COO_THREAD_ID, `CEO とリーダーが話し中のため、${action.type === "present" ? "報告" : "連絡"}を保留しました（指示 ${instr.id.slice(0, 8)}）`, instr.id);
            break;
          }
          try {
            if (action.type === "present") {
              await ctx.api.patchInstruction(instr.id, { expectedRevision: action.revision, status: "review", resultSummary: clip(action.summary, 12_000) });
              out.kind = "report";
              out.instructionId = instr.id;
              out.ref = { ...out.ref, revision: action.revision };
              out.fallbackBody ??= action.summary;
            } else {
              await ctx.api.patchInstruction(instr.id, { expectedRevision: action.revision });
              if (instr.projectId) await toLeader(ctx, { leaderThreadId: leaderThreadIdOf(instr.projectId), cooAgentId: input.agentId, body: action.message, instructionId: instr.id, kind: "chat" });
            }
            out.acted = true;
          } catch (err) {
            if (!(err instanceof StaleRevisionError)) throw err;
            const details = err.details as { revision?: number } | undefined;
            await notice(ctx, COO_THREAD_ID, `方針が変わった（rev ${details?.revision ?? "?"}）。リーダーの報告を待ってから`, instr.id);
          }
          break;
        }
        case "answer_leader": {
          let projectId: string | null = null;
          if (action.instructionId) projectId = context.openInstructions.find((i) => i.id === action.instructionId)?.projectId ?? null;
          if (!projectId) {
            // 質問してきたリーダー（受信箱の delegation の指示）から探す
            const q = input.inbox.find((i) => i.kind === "delegation" && i.instructionId);
            projectId = q ? (context.openInstructions.find((i) => i.id === q.instructionId)?.projectId ?? null) : null;
          }
          if (!projectId) {
            await notice(ctx, COO_THREAD_ID, "answer_leader の宛先のリーダーが分かりませんでした");
            break;
          }
          await toLeader(ctx, { leaderThreadId: leaderThreadIdOf(projectId), cooAgentId: input.agentId, body: action.message, instructionId: action.instructionId, kind: "chat" });
          out.acted = true;
          break;
        }
      }
    } catch (err) {
      ctx.log.error("COO の行動に失敗", { type: action.type, error: errorMessage(err) });
      await notice(ctx, COO_THREAD_ID, `${action.type} を行えませんでした: ${clip(errorMessage(err), 300)}`);
    }
  }
  return out;
}

export async function executeLeaderActions(
  ctx: RunnerContext,
  input: { thread: ThreadClaim["thread"]; project: ProjectWithTeam; messageId: string; value: LeaderTurn; context: ThreadTurnContext; inbox: readonly InboxItem[]; hasCeo: boolean },
): Promise<Applied> {
  const out: Applied = { kind: "chat", instructionId: null, ref: {}, fallbackBody: null, acted: false };
  const { project, value } = input;
  const leaderName = project.name;
  const members = project.agents.filter((a) => a.role === "member" && a.active);
  const agentIdOf = (name: string) => members.find((m) => m.name === name)?.id ?? members.find((m) => name.includes(m.name) || m.name.includes(name))?.id ?? null;

  for (const action of value.actions) {
    try {
      switch (action.type) {
        case "plan": {
          let instructionId = action.instructionId;
          const open = instructionId ? input.context.openInstructions.find((i) => i.id === instructionId) : null;
          if (!instructionId) {
            const ceo = [...input.inbox].reverse().find((i) => i.kind === "ceo_message");
            const created = await ctx.api.createInstruction({
              id: randomUUID(),
              title: clip(action.newTitle ?? action.tasks[0]?.title ?? "新しい仕事", 60),
              body: clip(String(ceo?.payload.body ?? action.tasks.map((t) => `${t.title}: ${t.spec}`).join("\n")), 8000) || "新しい仕事",
              projectId: project.id,
              originThreadId: input.thread.id,
              originMessageId: input.messageId,
              phase: "members",
            });
            instructionId = created.id;
          } else if (open && (open.status === "review" || open.status === "done")) {
            await ctx.api.patchInstruction(instructionId, { reopen: true, ...(action.newTitle ? { title: action.newTitle } : {}) }).catch((err: unknown) => {
              // ターンの文脈より後に、もう running になっていた（同じ時刻の別のターンなど）: そのまま計画を入れる
              if (err instanceof ConflictError && (err.details as { status?: string } | undefined)?.status === "running") return;
              throw err;
            });
          }
          const st = await ctx.state.instruction(instructionId);
          const round = Math.min(ctx.config.limits.maxRounds, Math.max(1, st.round + 1));
          await ctx.state.patchInstruction(instructionId, { round: Math.max(st.round + 1, 1) });
          await ctx.api.createTasks({
            tasks: action.tasks.map((t, i) => ({
              id: randomUUID(),
              instructionId: instructionId!,
              parentTaskId: null,
              assigneeAgentId: agentIdOf(t.assignee),
              kind: "work" as const,
              planKey: t.key,
              dependsOn: t.dependsOn,
              title: t.title || t.key,
              spec: t.spec,
              paths: t.paths,
              round,
              seq: i,
            })),
          });
          await ctx.api.patchInstruction(instructionId, { status: "running", phase: "members" });
          out.instructionId ??= instructionId;
          out.acted = true;
          break;
        }
        case "answer_member": {
          if (!ctx.coord.answerMember(action.sessionId, action.message)) {
            // 動いていなければ次の起動で --resume に渡す
            const st = await ctx.state.session(action.sessionId);
            await ctx.state.patchSession(action.sessionId, { cwd: st?.cwd ?? "", pendingAnswer: action.message });
          }
          out.acted = true;
          break;
        }
        case "resolve_conflict": {
          const st = await ctx.state.instruction(action.instructionId);
          const branch = st.conflicts?.[action.taskKey];
          if (!branch) {
            await notice(ctx, input.thread.id, `衝突の記録が見つかりません（${action.taskKey}）`, action.instructionId);
            break;
          }
          await ctx.api.createTasks({
            tasks: [
              {
                id: randomUUID(),
                instructionId: action.instructionId,
                parentTaskId: null,
                assigneeAgentId: agentIdOf(action.assignee),
                kind: "work",
                planKey: null,
                dependsOn: [],
                title: clip(`衝突の解決: ${action.taskKey}`, 80),
                spec: `${CONFLICT_SPEC_PREFIX}${branch}\n作業フォルダの衝突の印（<<<<<<< ======= >>>>>>>）を、両方の変更の意図を活かして解消する。`,
                paths: [],
                round: Math.min(ctx.config.limits.maxRounds, Math.max(1, st.round)),
                seq: 100,
              },
            ],
          });
          await ctx.api.patchInstruction(action.instructionId, { status: "running", phase: "members" });
          out.acted = true;
          break;
        }
        case "report": {
          await ctx.api.patchInstruction(action.instructionId, { phase: "coo" });
          await ctx.api.pushInbox(COO_THREAD_ID, {
            kind: "work_report",
            wakes: true,
            instructionId: action.instructionId,
            payload: { leaderName, summary: action.summary, openIssues: action.openIssues },
          });
          out.instructionId ??= action.instructionId;
          out.acted = true;
          break;
        }
        case "ask_coo": {
          await ctx.api.pushInbox(COO_THREAD_ID, { kind: "delegation", wakes: true, instructionId: action.instructionId, payload: { question: action.question, leaderName } });
          out.acted = true;
          break;
        }
      }
    } catch (err) {
      ctx.log.error("リーダーの行動に失敗", { type: action.type, error: errorMessage(err) });
      await notice(ctx, input.thread.id, `${action.type} を行えませんでした: ${clip(errorMessage(err), 300)}`, null);
    }
  }

  // COO への報告（D-78）: COO スレッドに leader_report、受信箱に leader_report（ターンは起こさない）、版を +1
  if (value.cooReport) {
    const r = value.cooReport;
    const first = r.instructionIds[0] ?? out.instructionId ?? null;
    await ctx.api
      .postMessage(COO_THREAD_ID, {
        id: randomUUID(),
        authorKind: "leader",
        authorAgentId: input.thread.agentId,
        kind: "leader_report",
        body: r.summary,
        instructionId: first,
        sessionId: null,
        ref: { threadId: input.thread.id, contextProjectId: project.id },
        status: "complete",
        notify: false,
      })
      .catch((err: unknown) => ctx.log.warn("leader_report を書けません", { error: errorMessage(err) }));
    await ctx.api
      .pushInbox(COO_THREAD_ID, { kind: "leader_report", wakes: false, instructionId: first, payload: { leaderName, summary: r.summary, change: r.change } })
      .catch((err: unknown) => ctx.log.warn("leader_report を受信箱に入れられません", { error: errorMessage(err) }));
    if (r.change !== "none") {
      const ids = new Set([...r.instructionIds, ...(out.instructionId ? [out.instructionId] : [])]);
      for (const id of ids) await ctx.api.patchInstruction(id, { revisionBump: true }).catch(() => undefined);
    }
    out.acted = true;
  }
  return out;
}

/** 衝突の解決タスクの spec の頭（ランナーが衝突の印を入れる元のブランチ） */
export const CONFLICT_SPEC_PREFIX = "衝突の解決: ";
