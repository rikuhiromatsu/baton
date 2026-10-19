// メンバーの段階（設計書 5.2 段階 3、5.5、5.6）。依存が満たされたタスクから、指示あたり最大 3 並列で実行する。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Agent, AskCeo, MemberTool, Task } from "@baton/shared";
import {
  AiQuotaError,
  AllWorkFailedError,
  ConflictError,
  LimitError,
  StageFailedError,
  StopSignal,
  errorMessage,
  isAbortError,
} from "../errors.ts";
import { buildMemberFirstUser, buildMemberMessages, buildMemberSystem, toolResultMessage, type MemberTurn } from "../prompts/member.ts";
import { askLimitMessage } from "../prompts/util.ts";
import { FsTools, isTextMime, mimeFor, toolErrorResult, type ToolResult } from "../tools/fs.ts";
import { NetGuardError } from "../tools/net-guard.ts";
import { resolveInWorkspace } from "../tools/path-guard.ts";
import { webFetch } from "../tools/web-fetch.ts";
import { askCeo, callStage } from "./ai-call.ts";
import type { RunContext } from "./context.ts";
import { isFinished } from "./resume.ts";

const STATUS_JA: Record<Task["status"], string> = { done: "完了", failed: "失敗", canceled: "取消", pending: "未着手", running: "実行中" };

// ───────────── 成果物 ─────────────

const ARTIFACT_HEADER = "成果物:";

/** work タスクの resultSummary の末尾に成果物の一覧を書く（state に成果物が無いので、再開時はここから読む） */
export function formatWorkSummary(summary: string, artifacts: { path: string; title: string }[]): string {
  const tail = artifacts.length ? `\n\n${ARTIFACT_HEADER}\n${artifacts.map((a) => `- ${a.path}（${a.title.replace(/[（）\n]/g, " ")}）`).join("\n")}` : "";
  const room = 4000 - tail.length;
  return (summary.length > room ? summary.slice(0, Math.max(0, room - 1)) + "…" : summary) + tail;
}

export function parseArtifactsFromSummary(summary: string | null): { path: string; title: string }[] {
  if (!summary) return [];
  const i = summary.lastIndexOf(`\n${ARTIFACT_HEADER}\n`);
  if (i < 0) return [];
  return summary
    .slice(i + ARTIFACT_HEADER.length + 2)
    .split("\n")
    .map((l) => /^- (.+?)（(.*)）$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[1] ?? "", title: m[2] ?? "" }));
}

async function sha256File(abs: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function readHead(abs: string, bytes: number): Promise<Buffer> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** 先頭 64KB を UTF-8 として読み、末尾の途切れた文字は落とす */
function previewOf(head: Buffer, maxChars: number): string {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (text.endsWith("�")) text = text.slice(0, -1);
  return text.slice(0, maxChars);
}

/** done.artifacts のファイルを読み、sha256・mime・サイズ・先頭 64KB のテキストで登録する */
export async function registerArtifacts(ctx: RunContext, task: Task, agent: Agent | null, list: { path: string; title: string }[], signal: AbortSignal): Promise<{ path: string; title: string }[]> {
  const out: { path: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    try {
      const p = await resolveInWorkspace(ctx.workspace(), a.path);
      if (seen.has(p.rel)) continue;
      seen.add(p.rel);
      if (!p.exists) throw new Error("ファイルがありません");
      const st = await stat(p.abs);
      if (!st.isFile()) throw new Error("ファイルではありません");
      const head = await readHead(p.abs, ctx.limits.artifactPreviewMaxChars);
      const mime = mimeFor(p.rel, head);
      const previewText = isTextMime(mime) ? previewOf(head, ctx.limits.artifactPreviewMaxChars) : null;
      await ctx.api.createArtifact(
        {
          instructionId: ctx.id,
          taskId: task.id,
          relPath: p.rel,
          title: a.title.slice(0, 80) || p.rel.slice(0, 80),
          mime,
          sizeBytes: st.size,
          sha256: await sha256File(p.abs),
          previewText,
        },
        { signal },
      );
      out.push({ path: p.rel, title: a.title });
    } catch (err) {
      if (signal.aborted || err instanceof ConflictError) throw err;
      await ctx.events.emit({ taskId: task.id, agentId: agent?.id ?? null, kind: "error", content: { stage: "work", message: `成果物を登録できません: ${a.path}（${errorMessage(err)}）` } });
    }
  }
  return out;
}

// ───────────── 道具 ─────────────

export async function execTool(ctx: RunContext, fs: FsTools, tool: MemberTool, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
  ctx.budget.checkTime();
  try {
    switch (tool) {
      case "fs_list":
        return await fs.fsList(args);
      case "fs_read":
        return await fs.fsRead(args);
      case "fs_write":
        return await fs.fsWrite(args);
      case "fs_append":
        return await fs.fsAppend(args);
      case "web_fetch": {
        if (ctx.webFetchCount >= ctx.limits.webFetchPerInstruction) {
          return { ok: false, text: `エラー: web_fetch は 1 つの指示で ${ctx.limits.webFetchPerInstruction} 回までです`, short: "web_fetch は回数の上限" };
        }
        ctx.webFetchCount++;
        const r = await webFetch(args.url, { limits: ctx.limits, signal, lookup: ctx.deps.lookup, transport: ctx.deps.transport });
        const head = `URL: ${r.url}\nステータス: ${r.status}\n種類: ${r.contentType || "不明"}${r.truncated ? "\n（上限で切りました）" : ""}\n\n`;
        return { ok: r.status < 400, text: head + r.text, short: `${r.url} を取得（${r.status}、${r.text.length} 文字）` };
      }
    }
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    if (err instanceof LimitError) throw err;
    if (isAbortError(err)) return toolErrorResult(tool, new NetGuardError("時間切れです"));
    return toolErrorResult(tool, err);
  }
}

// ───────────── 1 タスク ─────────────

type MemberOutcome = { status: "done" | "failed" } | { status: "ask"; ask: AskCeo; agent: Agent | null };

function clipJson(v: unknown, max: number): unknown {
  const s = JSON.stringify(v) ?? "";
  return s.length > max ? s.slice(0, max) + "…" : v;
}

export async function runMemberTask(ctx: RunContext, task: Task, signal: AbortSignal): Promise<MemberOutcome> {
  const project = ctx.project;
  if (!project) throw new StageFailedError("プロジェクトが決まっていません");
  const members = ctx.members();
  const agent = members.find((m) => m.id === task.assigneeAgentId) ?? project.agents.find((a) => a.id === task.assigneeAgentId) ?? members[0] ?? null;
  const leader = ctx.leader();
  // 前回の実行で途中まで進んでいた（開始済み）か。再開時の重複追記を避けるための注意に使う
  const resumed = task.startedAt !== null;
  await ctx.patchTask(task.id, { status: "running" }, signal);

  const sameRound = ctx.workTasks(task.round);
  const deps = task.dependsOn
    .map((k) => sameRound.find((t) => t.planKey === k))
    .filter((t): t is Task => !!t)
    .map((t) => ({ key: t.planKey ?? "-", title: t.title, status: STATUS_JA[t.status], summary: t.resultSummary ?? "" }));

  const input = {
    body: ctx.instruction.body,
    feedback: ctx.instruction.feedback,
    decisions: ctx.decisions,
    projectName: project.name,
    memberName: agent?.name ?? "メンバー",
    specialty: agent?.specialty ?? "",
    leaderName: leader.name,
    taskKey: task.planKey ?? "t1",
    taskTitle: task.title,
    taskSpec: task.spec,
    dependencies: deps,
    maxTurns: ctx.limits.memberTurns,
    decisionsLeft: ctx.decisionsLeft(),
    limits: ctx.limits,
    resumed,
  };
  const system = buildMemberSystem(input);
  const firstUser = buildMemberFirstUser(input);
  const fs = ctx.fsTools();
  await fs.ensureRoot();
  const turns: MemberTurn[] = [];
  const agentId = agent?.id ?? null;

  for (let turn = 0; turn < ctx.limits.memberTurns; turn++) {
    const messages = buildMemberMessages(system, firstUser, turns, ctx.limits.memberRecentTurns);
    const { action } = await callStage(ctx, { stage: "member_step", role: "member", messages, taskId: task.id, agentId, signal });
    const turnsLeft = ctx.limits.memberTurns - turn - 1;
    const assistant = JSON.stringify(action);

    if (action.kind === "tool") {
      await ctx.events.emit({ taskId: task.id, agentId, kind: "tool_call", content: { tool: action.tool, args: clipJson(action.args, 2000), why: action.why } });
      const result = await execTool(ctx, fs, action.tool, action.args, signal);
      await ctx.events.emit({ taskId: task.id, agentId, kind: "tool_result", content: { tool: action.tool, ok: result.ok, text: result.text } });
      const msg = toolResultMessage(action.tool, result.text, turnsLeft, ctx.limits.memberToolResultChars);
      turns.push({ assistant, user: msg.full, userShort: msg.short(result.short) });
      continue;
    }

    await ctx.events.emit({ taskId: task.id, agentId, kind: "action", content: { stage: "work", taskKey: task.planKey, action } });

    if (action.kind === "done") {
      const registered = await registerArtifacts(ctx, task, agent, action.artifacts, signal);
      const summary = formatWorkSummary(action.summary, registered);
      await ctx.patchTask(task.id, { status: "done", resultSummary: summary }, signal);
      await ctx.events.emit({ taskId: task.id, agentId, kind: "summary", content: { stage: "work", taskKey: task.planKey, text: summary } });
      return { status: "done" };
    }
    if (action.kind === "give_up") {
      await ctx.patchTask(task.id, { status: "failed", resultSummary: `諦めました: ${action.reason}`.slice(0, 4000) }, signal);
      return { status: "failed" };
    }
    // ask_ceo
    if (ctx.decisionsLeft() > 0) return { status: "ask", ask: action, agent };
    const refusal = askLimitMessage(ctx.limits.decisionsPerInstruction);
    turns.push({ assistant, user: refusal, userShort: refusal });
  }

  const reason = `上限: ターン（${ctx.limits.memberTurns} 回）に達しても完了しませんでした`;
  await ctx.events.emit({ taskId: task.id, agentId, kind: "error", content: { stage: "work", message: reason } });
  await ctx.patchTask(task.id, { status: "failed", resultSummary: reason }, signal);
  return { status: "failed" };
}

// ───────────── 段階 3 ─────────────

/** 指示の失敗にすべきエラー（メンバーのタスクだけの失敗にしない） */
function isFatal(err: unknown): boolean {
  return err instanceof LimitError || err instanceof AiQuotaError || err instanceof ConflictError || isAbortError(err) || !(err instanceof StageFailedError);
}

export async function runWorkStage(ctx: RunContext, round: number): Promise<void> {
  const stage = new AbortController();
  const onParentAbort = () => stage.abort(ctx.signal.reason);
  if (ctx.signal.aborted) throw ctx.signal.reason;
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });

  const running = new Map<string, Promise<void>>();
  let fatal: unknown = null;
  let ask: { ask: AskCeo; task: Task; agent: Agent | null } | null = null;

  const isDone = (key: string) => {
    const t = ctx.workTasks(round).find((x) => x.planKey === key);
    return !t || isFinished(t);
  };

  try {
    for (;;) {
      if (fatal || ask) break;
      const pending = ctx.workTasks(round).filter((t) => !isFinished(t) && !running.has(t.id));
      if (pending.length === 0 && running.size === 0) break;
      let ready = pending.filter((t) => t.dependsOn.every(isDone));
      // 依存が解けずに止まる場合（循環が残った等）は、順番に 1 つずつ実行する
      if (ready.length === 0 && running.size === 0 && pending[0]) ready = [pending[0]];
      for (const t of ready) {
        if (running.size >= ctx.limits.memberParallel) break;
        const p = (async () => {
          try {
            const r = await runMemberTask(ctx, t, stage.signal);
            if (r.status === "ask" && !ask) {
              ask = { ask: r.ask, task: t, agent: r.agent };
              stage.abort(new StopSignal("decision"));
            }
          } catch (err) {
            if (stage.signal.aborted && !ctx.signal.aborted && ask) return; // 判断待ちで止めたもの
            if (isFatal(err)) {
              if (!fatal) fatal = err;
              stage.abort(err instanceof Error && isAbortError(err) ? err : new StopSignal("cancel"));
              return;
            }
            // 段階の失敗（AI が使えない・JSON が直らない）はこのタスクだけ failed にして続ける
            ctx.log.warn("メンバーのタスクが失敗", { instructionId: ctx.id, task: t.planKey, error: errorMessage(err) });
            await ctx.events.emit({ taskId: t.id, agentId: t.assigneeAgentId, kind: "error", content: { stage: "work", message: errorMessage(err) } });
            await ctx.patchTask(t.id, { status: "failed", resultSummary: `失敗: ${errorMessage(err)}`.slice(0, 4000) }, stage.signal);
          } finally {
            running.delete(t.id);
          }
        })().catch((err: unknown) => {
          if (!fatal && !(stage.signal.aborted && ask)) fatal = err;
          stage.abort(new StopSignal("cancel"));
        });
        running.set(t.id, p);
      }
      if (running.size > 0) await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
  } finally {
    ctx.signal.removeEventListener("abort", onParentAbort);
  }

  if (ctx.signal.aborted) throw ctx.signal.reason;
  if (fatal) throw fatal;
  const asked = ask as { ask: AskCeo; task: Task; agent: Agent | null } | null;
  if (asked) return askCeo(ctx, asked.ask, { taskId: asked.task.id, agentId: asked.agent?.id ?? null, stage: "work" });

  const works = ctx.workTasks();
  if (works.length > 0 && works.every((t) => t.status === "failed")) {
    const reasons = works.map((t) => `${t.planKey ?? ""} ${t.title}: ${t.resultSummary ?? "理由不明"}`).join(" / ");
    throw new AllWorkFailedError(`すべての作業タスクが失敗しました（${reasons}）`.slice(0, 3900));
  }
}
