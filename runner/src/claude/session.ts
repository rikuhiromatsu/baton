// 1 つの Claude のセッション（COO・リーダーはスレッドごと、メンバーは作業ごと。DESIGN-v2 5.3）。
// 起動（プロファイル・設定・引数）、1 ターンの送受信、承認（7.6）、init の検査（7.7）、枠（9 章）、トランスクリプトとストリーム（4.7・8.4）。
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  approvalItem,
  runnerEventItem,
  userInputItem,
  type NormalizeResult,
  type SessionInitInfo,
  type SessionResultInfo,
} from "@baton/shared";
import { dataPaths } from "../config.ts";
import type { RunnerContext } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { approvalQuestion, decidePermission } from "./approval.ts";
import { buildArgs, buildSettings, writeSettings, type LaunchSpec } from "./args.ts";
import { childEnv, checkInit } from "./env.ts";
import type { ClaudeRole } from "./permissions.ts";
import { ClaudeProcess, type ProcessExit } from "./process.ts";
import { buildPluginDir, type Profile } from "./profiles.ts";
import { StreamSink, TranscriptSink } from "./sink.ts";

export type SessionOptions = {
  role: ClaudeRole;
  sessionId: string;
  resume: boolean;
  cwd: string;
  addDirs: string[];
  model: string;
  fallbackModel: string | null;
  profileId: string;
  profile: Profile;
  systemPrompt: string;
  threadId: string | null;
  instructionId: string | null;
  taskId: string | null;
  agentId: string | null;
  /** リーダーのサンドボックスの書き込み禁止（本体・worktrees・projects） */
  denyWrite?: string[];
  extraDomains?: string[];
  oneTimeAllow?: string[];
  startSeq?: number;
  /** 承認を CEO に聞けるか（メンバーだけ。指示が要る） */
  approvals?: { instructionId: string; count: () => number; bump: () => void } | null;
  /** 承認の待ちの間の状態の変化（awaiting_approval ↔ running） */
  onApprovalState?: (waiting: boolean) => void;
};

export type ApprovalTimeout = { approvalId: string; toolName: string; toolInput: Record<string, unknown> };

export type TurnOutcome = {
  result: SessionResultInfo | null;
  replyText: string;
  structured: unknown;
  exit: ProcessExit | null;
  /** apiKeySource・MCP の検査に落ちた（即停止） */
  authViolation: string | null;
  approvalTimeout: ApprovalTimeout | null;
  interrupted: boolean;
  stderr: string;
};

export class AgentSession {
  readonly sink: TranscriptSink;
  private proc: ClaudeProcess | null = null;
  private stream: StreamSink | null = null;
  private init: SessionInitInfo | null = null;
  private authViolation: string | null = null;
  private approvalTimeout: ApprovalTimeout | null = null;
  private approvalsInFlight: Promise<void> = Promise.resolve();
  private activity: string | null = null;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private interrupted = false;
  args: string[] = [];
  /** 現在のターンが扱っている指示（スレッドのターンの項目に入れる。8.3 の最後） */
  turnInstructionId: string | null;

  private readonly ctx: RunnerContext;
  readonly opts: SessionOptions;

  constructor(ctx: RunnerContext, opts: SessionOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.turnInstructionId = opts.instructionId;
    this.sink = new TranscriptSink(
      { api: ctx.api, log: ctx.log, liveLog: ctx.liveLog, flushMs: ctx.config.limits.transcriptFlushMs, summaryOnly: ctx.config.transcriptSummaryOnly, now: ctx.now },
      opts.sessionId,
      opts.threadId,
      opts.instructionId,
      opts.startSeq ?? 0,
    );
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }
  get alive(): boolean {
    return this.proc !== null && !this.proc.exited;
  }
  get busy(): boolean {
    return this.proc?.busy === true;
  }
  get pid(): number | undefined {
    return this.proc?.pid;
  }
  get initInfo(): SessionInitInfo | null {
    return this.init;
  }

  /** 起動（設定・プロファイルのスキルの写し・引数を作って spawn） */
  async launch(): Promise<void> {
    const { config } = this.ctx;
    const o = this.opts;
    const runDir = dataPaths(config).runSession(o.sessionId);
    const settingsPath = path.join(runDir, "settings.json");
    await writeSettings(settingsPath, buildSettings({ role: o.role, denyWrite: o.denyWrite, extraDomains: [...(o.extraDomains ?? []), ...(o.profile.extraDomains ?? []), ...config.extraAllowedDomains] }));
    const pluginDir = o.role === "member" ? await buildPluginDir(config, o.profileId, o.profile) : null;
    const spec: LaunchSpec = {
      role: o.role,
      sessionId: o.sessionId,
      resume: o.resume,
      cwd: o.cwd,
      addDirs: o.addDirs,
      model: o.model,
      fallbackModel: o.fallbackModel,
      maxTurns: config.limits.maxTurns[o.role],
      maxBudgetUsd: config.limits.maxBudgetUsd[o.role],
      systemPrompt: o.systemPrompt,
      pluginDir,
      hasSkills: pluginDir !== null,
      settingsPath,
      oneTimeAllow: o.oneTimeAllow ?? [],
      extraAllow: config.extraBashAllow,
      name: `baton:${o.role}:${o.sessionId.slice(0, 8)}`,
    };
    this.args = buildArgs(spec);
    const day = new Date(this.ctx.now()).toISOString().slice(0, 10);
    this.proc = new ClaudeProcess({
      bin: config.claudeBin,
      args: this.args,
      cwd: o.cwd,
      env: childEnv({ home: config.home, passthrough: process.env }),
      sessionId: o.sessionId,
      rawLogDir: path.join(dataPaths(config).logs, day),
      log: this.ctx.log,
    });
    this.proc.on((r) => this.onStream(r));
    this.proc.start();
    this.ctx.log.info("claude を起動しました", { role: o.role, sessionId: o.sessionId, resume: o.resume, cwd: o.cwd, model: o.model, pid: this.proc.pid });
  }

  private onStream(r: NormalizeResult): void {
    for (const it of r.items) this.sink.add(it, this.turnInstructionId);
    if (r.session?.kind === "init") {
      this.init = r.session;
      this.ctx.auth.claudeVersion = r.session.claudeCodeVersion ?? this.ctx.auth.claudeVersion;
      const bad = checkInit(r.session);
      if (bad) {
        this.authViolation = bad;
        this.ctx.auth.trip(bad);
        this.ctx.log.error("claude の起動を止めます（7.7）", { sessionId: this.sessionId, reason: bad });
        this.proc?.kill("SIGTERM");
      } else {
        this.ctx.log.info("claude の init", {
          sessionId: this.sessionId,
          apiKeySource: r.session.apiKeySource,
          mcpServers: r.session.mcpServers.length,
          skills: r.session.skills.filter((s) => s.startsWith("baton-")),
          model: r.session.model,
          version: r.session.claudeCodeVersion,
        });
      }
    }
    if (r.quota) this.ctx.quota.observe(r.quota);
    if (r.session?.kind === "result" && r.session.limitHit) this.ctx.quota.limitHit();
    if (r.delta && this.stream) {
      if (r.delta.type === "text") this.stream.append(r.delta.text);
      else this.stream.reset();
    }
    if (r.activity !== undefined) this.setActivity(r.activity);
    if (r.control?.kind === "can_use_tool") {
      const c = r.control;
      this.approvalsInFlight = this.approvalsInFlight.then(() => this.handlePermission(c.requestId, c.toolName, c.input, c.toolUseId)).catch((err) => {
        this.ctx.log.warn("承認の処理で例外", { sessionId: this.sessionId, error: errorMessage(err) });
        this.proc?.respond(c.requestId, { behavior: "deny", message: "承認の処理に失敗しました" });
      });
    }
  }

  private setActivity(a: string | null): void {
    this.activity = a;
    this.stream?.setActivity(a);
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      void this.ctx.api.patchSession(this.sessionId, { activity: this.activity }).catch(() => undefined);
    }, 1000);
    this.activityTimer.unref?.();
  }

  private async handlePermission(requestId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string | null): Promise<void> {
    const { config } = this.ctx;
    const verdict = decidePermission({ role: this.opts.role, toolName, toolInput, cwd: this.opts.cwd, home: config.home, dataDir: config.dataDir });
    if (verdict.kind === "allow") {
      this.proc?.respond(requestId, { behavior: "allow", updatedInput: toolInput });
      return;
    }
    if (verdict.kind === "deny") {
      this.proc?.respond(requestId, { behavior: "deny", message: verdict.message });
      return;
    }
    const ap = this.opts.approvals;
    if (!ap) {
      this.proc?.respond(requestId, { behavior: "deny", message: "この作業では承認を求められません" });
      return;
    }
    if (ap.count() >= config.limits.approvalsPerInstruction) {
      this.proc?.respond(requestId, { behavior: "deny", message: "この指示の承認の回数が上限に達しました" });
      return;
    }
    ap.bump();
    const decision = await this.ctx.api.createApproval({
      id: randomUUID(),
      instructionId: ap.instructionId,
      sessionId: this.sessionId,
      taskId: this.opts.taskId,
      askedByAgentId: this.opts.agentId,
      toolName,
      toolInput,
      toolUseId,
      question: approvalQuestion(toolName, toolInput),
    });
    this.sink.add(approvalItem({ decisionId: decision.id, toolName, toolInput, toolUseId, cwd: this.opts.cwd }));
    this.opts.onApprovalState?.(true);
    const ac = new AbortController();
    const answered = await this.ctx.decisions.wait(this.ctx.api, decision.id, config.limits.approvalWaitMs, ac.signal).catch(() => null);
    this.opts.onApprovalState?.(false);
    if (answered && answered.verdict === "allow") {
      this.proc?.respond(requestId, { behavior: "allow", updatedInput: toolInput });
      return;
    }
    if (answered) {
      this.proc?.respond(requestId, { behavior: "deny", message: `CEO が拒否しました${answered.answer ? `: ${answered.answer}` : ""}` });
      return;
    }
    // 10 分過ぎた: 拒否して中断し、判断待ちに落とす（呼び出し側が paused にする）
    this.approvalTimeout = { approvalId: decision.id, toolName, toolInput };
    this.proc?.respond(requestId, { behavior: "deny", message: "CEO の返事が時間内に無かったので、いったん止めます" });
    this.interruptTurn();
  }

  /** 1 ターン: 入力を送り、result まで待つ */
  async turn(text: string, opts: { author?: "ceo" | "runner"; stream?: StreamSink | null; signal?: AbortSignal; instructionId?: string | null } = {}): Promise<TurnOutcome> {
    if (!this.proc) throw new Error("launch の前に turn は呼べません");
    this.stream = opts.stream ?? null;
    this.interrupted = false;
    this.approvalTimeout = null;
    if (opts.instructionId !== undefined) this.turnInstructionId = opts.instructionId;
    this.sink.add(userInputItem(text, opts.author ?? "runner"), this.turnInstructionId);
    const resultP = this.proc.waitResult();
    const onAbort = () => this.interruptTurn();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let result: SessionResultInfo | null = null;
    try {
      if (!this.proc.send(text)) result = null;
      else result = await resultP;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    await this.approvalsInFlight;
    await this.stream?.flush();
    this.stream = null;
    if (result) {
      void this.ctx.api
        .patchSession(this.sessionId, {
          // スレッドのセッションのターン数は turn-done の numTurns で Worker が足す（二重に数えない）
          ...(this.opts.threadId === null ? { turnsDelta: Math.max(0, Math.floor(result.numTurns)) } : {}),
          costUsdDelta: Math.max(0, result.costUsdEst),
          tokensInDelta: Math.max(0, Math.floor(result.tokensIn)),
          tokensOutDelta: Math.max(0, Math.floor(result.tokensOut)),
          ...(this.init?.claudeCodeVersion ? { claudeVersion: this.init.claudeCodeVersion.slice(0, 40) } : {}),
          activity: null,
        })
        .catch(() => undefined);
    }
    const exit = result ? null : await this.proc.waitExit(5000);
    await this.sink.flush();
    return {
      result,
      replyText: result?.replyText ?? "",
      structured: result?.structuredOutput,
      exit,
      authViolation: this.authViolation,
      approvalTimeout: this.approvalTimeout,
      interrupted: this.interrupted,
      stderr: this.proc.stderr,
    };
  }

  /** ターン中に追加の入力を流す（4.5・5.6） */
  inject(text: string, author: "ceo" | "runner" = "ceo"): boolean {
    if (!this.proc || this.proc.exited) return false;
    this.sink.add(userInputItem(text, author), this.turnInstructionId);
    return this.proc.send(text);
  }

  interruptTurn(): void {
    if (!this.proc || this.proc.exited) return;
    this.interrupted = true;
    this.sink.add(runnerEventItem("中断"), this.turnInstructionId);
    if (this.proc.busy) this.proc.interrupt();
  }

  /** 次の result を待つ（idle 中に流し込んだ入力のターン） */
  waitResult(signal?: AbortSignal): Promise<SessionResultInfo | null> {
    return this.proc ? this.proc.waitResult(signal) : Promise.resolve(null);
  }

  /** 閉じる（ターン中なら interrupt → 2 秒 → 標準入力を閉じる → 5 秒で SIGTERM。D-67） */
  async close(opts: { interrupt?: boolean } = {}): Promise<void> {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.proc) {
      await this.proc.stop({
        interrupt: opts.interrupt ?? true,
        resultWaitMs: this.ctx.config.limits.cancelCloseStdinMs,
        closeWaitMs: this.ctx.config.limits.cancelSigtermMs,
      });
    }
    await this.sink.flush();
  }
}
