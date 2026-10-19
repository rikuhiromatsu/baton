// リーダーの段階（設計書 5.2 段階 2: 計画、段階 4: まとめ）。
import type { Agent, PlanTask, Task } from "@baton/shared";
import { StageFailedError } from "../errors.ts";
import { buildLeaderPlanMessages, buildLeaderReviewMessages } from "../prompts/leader.ts";
import { jsonErrorMessage } from "../prompts/util.ts";
import { listWorkspace } from "../tools/fs.ts";
import { askCeo, callStage, callStageWithAsk } from "./ai-call.ts";
import type { RunContext } from "./context.ts";

/** 依存の循環を探す。見つかればその経路（key の並び）を返す */
export function findCycle(tasks: Pick<PlanTask, "key" | "dependsOn">[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn.filter((d) => tasks.some((x) => x.key === d))]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 1);
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.key);
    if (c) return c;
  }
  return null;
}

/**
 * 計画を整える: key の重複を除き、存在しない依存と自分への依存を落とし、担当をメンバーの名前に合わせる。
 * 循環が残っていれば sequential=true のとき依存を無視して順番に実行する形（前のタスクに依存）にする。
 */
export function normalizePlan(tasks: PlanTask[], members: Agent[], opts: { sequential?: boolean } = {}): { tasks: PlanTask[]; assignees: Map<string, Agent> } {
  const seen = new Set<string>();
  const uniq = tasks.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
  const keys = new Set(uniq.map((t) => t.key));
  let out = uniq.map((t) => ({ ...t, dependsOn: [...new Set(t.dependsOn.filter((d) => keys.has(d) && d !== t.key))] }));
  if (opts.sequential) out = out.map((t, i) => ({ ...t, dependsOn: i === 0 ? [] : [out[i - 1]!.key] }));
  const assignees = new Map<string, Agent>();
  out.forEach((t, i) => {
    const exact = members.find((m) => m.name === t.assignee) ?? members.find((m) => m.name.trim() === t.assignee.trim());
    const loose = exact ?? members.find((m) => t.assignee.includes(m.name) || m.name.includes(t.assignee));
    const m = loose ?? members[i % Math.max(1, members.length)];
    if (m) assignees.set(t.key, m);
  });
  return { tasks: out, assignees };
}

async function workspaceFiles(ctx: RunContext): Promise<string[]> {
  try {
    const { entries } = await listWorkspace(ctx.workspace(), "", 200);
    return entries.map((e) => (e.type === "dir" ? e.path : `${e.path}（${e.size} バイト）`));
  } catch {
    return [];
  }
}

/** 計画からラウンドの work タスクを作る */
async function createWorkTasks(ctx: RunContext, plan: Task, tasks: PlanTask[], assignees: Map<string, Agent>, round: number): Promise<Task[]> {
  return ctx.createTasks(
    tasks.map((t) =>
      ctx.newTaskInput({
        parentTaskId: plan.id,
        assigneeAgentId: assignees.get(t.key)?.id ?? null,
        kind: "work",
        planKey: t.key,
        dependsOn: t.dependsOn,
        title: t.title.slice(0, 80),
        spec: t.spec.slice(0, 2000),
        round,
      }),
    ),
  );
}

function planSummary(tasks: PlanTask[], assignees: Map<string, Agent>): string {
  return tasks
    .map((t) => `${t.key} ${t.title}（${assignees.get(t.key)?.name ?? t.assignee}${t.dependsOn.length ? `、${t.dependsOn.join("・")} の後` : ""}）`)
    .join("\n")
    .slice(0, 4000);
}

/** 依存の循環があれば 1 回だけ直させ、それでもだめなら順番に実行する（5.2） */
async function fixCycles(
  ctx: RunContext,
  tasks: PlanTask[],
  retry: (problem: string) => Promise<PlanTask[] | null>,
): Promise<{ tasks: PlanTask[]; sequential: boolean }> {
  const cycle = findCycle(tasks);
  if (!cycle) return { tasks, sequential: false };
  const problem = `dependsOn が循環しています（${cycle.join(" → ")}）。循環しないように直してください`;
  await ctx.events.emit({ taskId: null, agentId: null, kind: "note", content: { message: problem } });
  const fixed = await retry(problem);
  if (fixed && !findCycle(fixed)) return { tasks: fixed, sequential: false };
  await ctx.events.emit({ taskId: null, agentId: null, kind: "note", content: { message: "依存の循環が直らないため、依存を無視して順番に実行します" } });
  return { tasks: fixed ?? tasks, sequential: true };
}

/** 段階 2: 計画 */
export async function runPlan(ctx: RunContext, round: number): Promise<void> {
  const leader = ctx.leader();
  let plan = ctx.planTask(round);
  if (!plan) {
    [plan] = await ctx.createTasks([
      ctx.newTaskInput({ parentTaskId: null, assigneeAgentId: leader.id, kind: "plan", planKey: null, dependsOn: [], title: "計画", spec: ctx.instruction.body.slice(0, 2000), round }),
    ]);
    if (!plan) throw new StageFailedError("計画タスクを作れませんでした");
  }
  const planId = plan.id;

  // 前回作った work タスクが残っていれば作り直さずに使う（5.9）
  const existing = ctx.workTasks(round).filter((t) => t.parentTaskId === planId);
  if (existing.length > 0) {
    if (plan.status !== "done") await ctx.patchTask(planId, { status: "done" });
    return;
  }

  if (plan.status !== "running") plan = await ctx.patchTask(planId, { status: "running" });
  const members = ctx.members();
  const project = ctx.project;
  if (!project) throw new StageFailedError("プロジェクトが決まっていません");

  const messages = buildLeaderPlanMessages({
    body: ctx.instruction.body,
    feedback: ctx.instruction.feedback,
    decisions: ctx.decisions,
    projectName: project.name,
    projectSummary: project.summary,
    leaderName: leader.name,
    brief: plan.spec || ctx.instruction.body,
    members,
    files: await workspaceFiles(ctx),
    decisionsLeft: ctx.decisionsLeft(),
  });
  const res = await callStageWithAsk(ctx, { stage: "leader_plan", role: "leader", messages, taskId: planId, agentId: leader.id });
  if (res.kind === "ask") return askCeo(ctx, res.ask, { taskId: planId, agentId: leader.id, stage: "plan" });

  const first = res.action.tasks;
  const fixed = await fixCycles(ctx, first, async (problem) => {
    const again = await callStage(ctx, {
      stage: "leader_plan",
      role: "leader",
      messages: [...messages, { role: "assistant", content: JSON.stringify(res.action) }, { role: "user", content: jsonErrorMessage(problem) }],
      taskId: planId,
      agentId: leader.id,
    });
    return again.action.kind === "plan" ? again.action.tasks : null;
  });
  const { tasks, assignees } = normalizePlan(fixed.tasks, members, { sequential: fixed.sequential });

  await createWorkTasks(ctx, plan, tasks, assignees, round);
  await ctx.events.emit({ taskId: planId, agentId: leader.id, kind: "action", content: { stage: "plan", action: { kind: "plan", tasks } } });
  await ctx.patchTask(planId, { status: "done", resultSummary: planSummary(tasks, assignees) });
}

export type ReviewResult = { revised: false } | { revised: true; round: number };

/** 段階 4: まとめ。revise ならラウンド +1 の計画と work を作る */
export async function runReview(ctx: RunContext, round: number, reopen: boolean): Promise<ReviewResult> {
  const leader = ctx.leader();
  const project = ctx.project;
  if (!project) throw new StageFailedError("プロジェクトが決まっていません");
  const plan = ctx.planTask(round);
  let review = ctx.reviewTask(round);
  if (!review) {
    [review] = await ctx.createTasks([
      ctx.newTaskInput({
        parentTaskId: plan?.id ?? null,
        assigneeAgentId: leader.id,
        kind: "review",
        planKey: null,
        dependsOn: [],
        title: round > 1 ? `まとめ（ラウンド ${round}）` : "まとめ",
        spec: "",
        round,
      }),
    ]);
    if (!review) throw new StageFailedError("まとめタスクを作れませんでした");
  }
  const reviewId = review.id;
  if (review.status !== "running") await ctx.patchTask(reviewId, { status: "running" });
  if (reopen) await ctx.events.emit({ taskId: reviewId, agentId: leader.id, kind: "note", content: { stage: "review", message: "差し戻しを受けて、まとめからやり直します" } });

  const canRevise = round < ctx.limits.maxRounds;
  const members = ctx.members();
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? project.agents.find((a) => a.id === id)?.name ?? "不明";
  const messages = buildLeaderReviewMessages({
    body: ctx.instruction.body,
    feedback: ctx.instruction.feedback,
    decisions: ctx.decisions,
    projectName: project.name,
    leaderName: leader.name,
    brief: ctx.planTask(1)?.spec || ctx.instruction.body,
    members,
    results: ctx.workTasks().map((t) => ({
      key: t.planKey ?? "-",
      title: t.title,
      assignee: memberName(t.assigneeAgentId),
      status: t.status,
      summary: t.resultSummary ?? "",
      round: t.round,
    })),
    round,
    canRevise,
    decisionsLeft: ctx.decisionsLeft(),
  });
  const res = await callStageWithAsk(ctx, {
    stage: "leader_review",
    role: "leader",
    messages,
    taskId: reviewId,
    agentId: leader.id,
    validate: (a) => (a.kind === "revise" && !canRevise ? "やり直し（revise）はもう使えません。足りない点は openIssues に書いて kind: report を返してください" : null),
  });
  if (res.kind === "ask") return askCeo(ctx, res.ask, { taskId: reviewId, agentId: leader.id, stage: "review" });
  const action = res.action;
  await ctx.events.emit({ taskId: reviewId, agentId: leader.id, kind: "action", content: { stage: "review", action } });

  if (action.kind === "report") {
    const issues = action.openIssues.length ? `\n\n残課題:\n${action.openIssues.map((s) => `- ${s}`).join("\n")}` : "";
    const text = (action.summary + issues).slice(0, 4000);
    await ctx.patchTask(reviewId, { status: "done", resultSummary: text });
    await ctx.events.emit({ taskId: reviewId, agentId: leader.id, kind: "summary", content: { stage: "review", text } });
    return { revised: false };
  }

  // revise: ラウンド +1 で同じ形（plan → work → review）をもう一度作る
  const next = round + 1;
  await ctx.patchTask(reviewId, { status: "done", resultSummary: `やり直し: ${action.reason}`.slice(0, 4000) });
  const [plan2] = await ctx.createTasks([
    ctx.newTaskInput({ parentTaskId: null, assigneeAgentId: leader.id, kind: "plan", planKey: null, dependsOn: [], title: `計画（ラウンド ${next}）`, spec: `やり直しの理由: ${action.reason}`.slice(0, 2000), round: next }),
  ]);
  if (!plan2) throw new StageFailedError("やり直しの計画タスクを作れませんでした");
  const fixed = await fixCycles(ctx, action.tasks, async () => null);
  const { tasks, assignees } = normalizePlan(fixed.tasks, members, { sequential: fixed.sequential });
  await createWorkTasks(ctx, plan2, tasks, assignees, next);
  await ctx.patchTask(plan2.id, { status: "done", resultSummary: planSummary(tasks, assignees) });
  return { revised: true, round: next };
}
