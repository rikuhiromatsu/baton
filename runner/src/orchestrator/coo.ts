// COO の段階（設計書 5.2 段階 1: 振り分け、段階 5: 最終報告）。
import { mkdir } from "node:fs/promises";
import { restoreLineBreaks } from "./text.ts";
import type { ProjectWithTeam } from "@baton/shared";
import { workspaceDir } from "../config.ts";
import { StageFailedError } from "../errors.ts";
import { buildCooFinalMessages, buildCooRouteMessages } from "../prompts/coo.ts";
import { askCeo, callStage, callStageWithAsk } from "./ai-call.ts";
import type { RunContext } from "./context.ts";
import { parseArtifactsFromSummary } from "./member.ts";

export type RouteResult = "routed" | "answered";

/** 段階 1: 振り分け */
export async function runRoute(ctx: RunContext): Promise<RouteResult> {
  const projects = ctx.activeProjects.filter((p) => p.status === "active");
  const messages = buildCooRouteMessages({
    body: ctx.instruction.body,
    feedback: ctx.instruction.feedback,
    decisions: ctx.decisions,
    projects,
    decisionsLeft: ctx.decisionsLeft(),
  });
  const res = await callStageWithAsk(ctx, {
    stage: "coo_route",
    role: "coo",
    messages,
    taskId: null,
    agentId: ctx.coo.id,
    validate: (a) =>
      a.kind === "route" && a.project.mode === "existing" && !projects.some((p) => p.id === (a.project as { projectId: string }).projectId)
        ? `project.projectId「${(a.project as { projectId: string }).projectId}」は既存のプロジェクト一覧にありません。一覧の id をそのまま使うか、mode を "new" にしてください`
        : null,
  });
  if (res.kind === "ask") return askCeo(ctx, res.ask, { taskId: null, agentId: ctx.coo.id, stage: "route" });
  const action = res.action;

  if (action.kind === "answer_directly") {
    // 先に振り分けのイベントを書き、そのあと review へ（逆順だと review になった後に書けない）
    await ctx.events.emit({ taskId: null, agentId: ctx.coo.id, kind: "action", content: { stage: "route", action } });
    await ctx.api.patchInstruction(ctx.id, { title: action.title, resultSummary: restoreLineBreaks(action.report).slice(0, 8000), status: "review" }, { signal: ctx.signal });
    ctx.log.info("COO が直接回答しました", { instructionId: ctx.id });
    return "answered";
  }

  // 件名は即座に反映
  await ctx.api.patchInstruction(ctx.id, { title: action.title }, { signal: ctx.signal });

  let project: ProjectWithTeam;
  if (action.project.mode === "existing") {
    const id = action.project.projectId;
    const found = projects.find((p) => p.id === id);
    if (!found) throw new StageFailedError(`既存のプロジェクトが見つかりません: ${id}`);
    project = found;
  } else {
    const p = action.project;
    project = await ctx.api.createProject(
      { instructionId: ctx.id, name: p.name, slug: p.slug, summary: p.summary, leader: p.leader, members: p.members },
      { signal: ctx.signal },
    );
    ctx.activeProjects.push(project);
  }
  ctx.project = project;
  await mkdir(workspaceDir(ctx.config, project.slug), { recursive: true });

  // メンバーが 1 人もいない既存プロジェクトには 1 人足す（リーダーが割り振れないため）
  if (ctx.members().length === 0) {
    const added = await ctx.api.addAgents(
      project.id,
      { instructionId: ctx.id, agents: [{ role: "member", name: "担当", specialty: "調査と文書作成" }] },
      { signal: ctx.signal },
    );
    project = { ...project, agents: [...project.agents, ...added] };
    ctx.project = project;
  }

  if (ctx.instruction.projectId !== project.id) {
    await ctx.api.patchInstruction(ctx.id, { projectId: project.id }, { signal: ctx.signal });
  }

  // 計画タスク（ラウンド 1）を作り、COO の方針を spec に残す（再開時に方針を取り戻すため）
  if (!ctx.planTask(1)) {
    await ctx.createTasks([
      ctx.newTaskInput({
        parentTaskId: null,
        assigneeAgentId: ctx.leader().id,
        kind: "plan",
        planKey: null,
        dependsOn: [],
        title: "計画",
        spec: action.brief.slice(0, 2000),
        round: 1,
      }),
    ]);
  }

  await ctx.events.emit({ taskId: null, agentId: ctx.coo.id, kind: "action", content: { stage: "route", action } });
  ctx.log.info("振り分けました", { instructionId: ctx.id, project: project.slug });
  return "routed";
}

/** 段階 5: 最終報告。指示を review にする */
export async function runFinal(ctx: RunContext, round: number): Promise<void> {
  const review =
    ctx.reviewTask(round) ??
    [...ctx.tasks].filter((t) => t.kind === "review" && t.status === "done").sort((a, b) => b.round - a.round)[0];
  const works = ctx.workTasks();
  const artifacts = works.flatMap((t) => parseArtifactsFromSummary(t.resultSummary));
  const failedTasks = works.filter((t) => t.status === "failed").map((t) => `${t.planKey ?? ""}「${t.title}」: ${t.resultSummary ?? ""}`);

  const messages = buildCooFinalMessages({
    body: ctx.instruction.body,
    feedback: ctx.instruction.feedback,
    decisions: ctx.decisions,
    title: ctx.instruction.title,
    leaderReport: review?.resultSummary ?? "（リーダーの報告がありません）",
    openIssues: [],
    artifacts,
    failedTasks,
  });
  const { action } = await callStage(ctx, { stage: "coo_final", role: "coo", messages, taskId: null, agentId: ctx.coo.id });
  await ctx.events.emit({ taskId: null, agentId: ctx.coo.id, kind: "action", content: { stage: "final", action } });
  await ctx.events.emit({ taskId: null, agentId: ctx.coo.id, kind: "summary", content: { stage: "final", text: action.report } });
  await ctx.api.patchInstruction(ctx.id, { status: "review", resultSummary: restoreLineBreaks(action.report).slice(0, 8000) }, { signal: ctx.signal });
  ctx.log.info("最終報告を出しました", { instructionId: ctx.id });
}
