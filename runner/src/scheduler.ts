// 仕事の取り出し（claim）と同時実行、ハートビート（DESIGN-v2 5.4・5.8、v1 の D-3）。
// - claim は 15 秒ごと＋WebSocket の合図で即時。種類（thread・instruction・finalize）はプロセスの空きで決める
// - 30 秒ごとのハートビートで lease を延ばし、枠・claude の版と認証・プロファイルを送り、取消・中断を受け取る
// - 停止（SIGTERM）: 全プロセスに interrupt → lease を外す → 5 秒で打ち切り
import type { ClaimOutput, ClaimInput, RunnerServerEvent } from "@baton/shared";
import { profileViews } from "./claude/profiles.ts";
import type { RunnerContext } from "./context.ts";
import { StopSignal, errorMessage } from "./errors.ts";
import { runFinalize } from "./orchestrator/finalize.ts";
import { runInstructionPhase } from "./orchestrator/instruction.ts";
import { runThreadTurn } from "./orchestrator/thread.ts";

type Active = { kind: ClaimOutput["kind"]; controller: AbortController; promise: Promise<void>; startedAt: number };

export type SchedulerHooks = {
  /** テストで差し替える */
  runThread?: typeof runThreadTurn;
  runInstruction?: typeof runInstructionPhase;
  runFinalize?: typeof runFinalize;
  onRescan?: () => void;
};

export class Scheduler {
  private readonly threads = new Map<string, Active>();
  private readonly instructions = new Map<string, Active>();
  private readonly finalizes = new Map<string, Active>();
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private claiming = false;
  private claimAgain = false;
  private heartbeating = false;
  private heartbeatAgain = false;
  private stopping = false;
  private unsubscribeQuota: (() => void) | null = null;
  private readonly lifecycle = new AbortController();
  lastHeartbeatAt: number | null = null;
  lastClaimError: string | null = null;

  private readonly ctx: RunnerContext;
  private readonly hooks: SchedulerHooks;
  constructor(ctx: RunnerContext, hooks: SchedulerHooks = {}) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  activeThreadIds(): string[] {
    return [...this.threads.keys()];
  }
  activeInstructionIds(): string[] {
    return [...new Set([...this.instructions.keys(), ...this.finalizes.keys()])];
  }
  activeSessionIds(): string[] {
    return [...new Set([...this.ctx.threads.sessionIds(), ...this.ctx.coord.memberSessions.keys()])];
  }

  start(): void {
    this.claimTimer = setInterval(() => this.poke(), this.ctx.config.limits.claimPollIntervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.ctx.config.limits.heartbeatIntervalMs);
    // 枠の状態（枠切れ・止めている・戻る時刻）が変わったら、次の定期のハートビートを待たずに送る（9 章。画面のリングと帯をすぐ変える）
    let lastQuota = quotaKey(this.ctx.quota.current);
    this.unsubscribeQuota = this.ctx.quota.onChange((q) => {
      const key = quotaKey(q);
      if (key === lastQuota) return;
      lastQuota = key;
      void this.heartbeat();
    });
    void this.heartbeat();
    this.poke();
  }

  poke(): void {
    if (this.stopping) return;
    void this.claimLoop();
  }

  /** WebSocket の合図（12.5） */
  onEvent(e: RunnerServerEvent): void {
    switch (e.t) {
      case "hello":
      case "work.available":
      case "thread.input":
        this.poke();
        break;
      case "instruction.cancel":
        this.cancel(e.instructionId);
        break;
      case "decision.answered":
        this.ctx.decisions.notify(e.decisionId);
        this.poke();
        break;
      case "thread.interrupt":
        this.ctx.threads.interrupt(e.threadId);
        break;
      case "session.interrupt":
        this.interruptSession(e.sessionId);
        break;
      case "session.input":
        void this.deliverInput(e.sessionId);
        break;
      case "repos.rescan":
        this.hooks.onRescan?.();
        break;
    }
  }

  /** 動いているメンバーへの追加の依頼（5.6）。止まっていれば次の claim で --resume */
  async deliverInput(sessionId: string): Promise<void> {
    const live = this.ctx.coord.memberSessions.get(sessionId);
    if (!live) {
      this.poke();
      return;
    }
    try {
      const items = await this.ctx.api.pendingInputs(sessionId);
      for (const it of items.filter((i) => i.status === "pending")) {
        if (live.inject(it.body)) await this.ctx.api.inputDelivered(it.id);
      }
    } catch (err) {
      this.ctx.log.warn("追加の依頼を渡せません", { sessionId, error: errorMessage(err) });
    }
  }

  interruptSession(sessionId: string): void {
    const live = this.ctx.coord.memberSessions.get(sessionId);
    if (live) live.interrupt();
    for (const [threadId] of this.threads) if (this.ctx.threads.get(threadId)?.sessionId === sessionId) this.ctx.threads.interrupt(threadId);
  }

  /** 取消（左フリック。5.7）: その指示のメンバーに interrupt → 2 秒で閉じる → 5 秒で SIGTERM。worktree は残す */
  cancel(instructionId: string): void {
    const a = this.instructions.get(instructionId);
    if (!a || a.controller.signal.aborted) return;
    this.ctx.log.info("取消を受けました。メンバーを止めます", { instructionId });
    a.controller.abort(new StopSignal("cancel"));
  }

  private kinds(): ClaimInput["kinds"] {
    const kinds: ClaimInput["kinds"] = ["finalize"];
    if (!this.ctx.auth.canStart) return kinds;
    if (this.ctx.quota.canStartThreadTurn() && this.ctx.threads.hasRoom() && this.threads.size < this.ctx.config.limits.threadProcesses) kinds.unshift("thread");
    if (this.ctx.memberSlots.inUse < this.ctx.memberSlots.size && this.instructions.size < this.ctx.config.limits.memberProcesses) kinds.push("instruction");
    return kinds;
  }

  async claimLoop(): Promise<void> {
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = true;
    try {
      do {
        this.claimAgain = false;
        for (let i = 0; i < 8 && !this.stopping; i++) {
          let res: ClaimOutput | null;
          try {
            res = await this.ctx.api.claim(
              {
                kinds: this.kinds(),
                activeThreadIds: this.activeThreadIds().slice(0, 16),
                activeInstructionIds: this.activeInstructionIds().slice(0, 16),
                quotaPaused: !this.ctx.quota.canStartMember(),
              },
              { signal: this.lifecycle.signal },
            );
            this.lastClaimError = null;
          } catch (err) {
            if (!this.stopping) {
              this.lastClaimError = errorMessage(err);
              this.ctx.log.warn("claim に失敗", { error: errorMessage(err) });
            }
            return;
          }
          if (!res) break;
          if (this.stopping) {
            await this.releaseClaim(res, "shutdown");
            return;
          }
          this.startRun(res);
        }
      } while (this.claimAgain && !this.stopping);
    } finally {
      this.claiming = false;
    }
  }

  private async releaseClaim(res: ClaimOutput, reason: "shutdown" | "error"): Promise<void> {
    if (res.kind === "thread") await this.ctx.api.releaseThread(res.thread.id, { reason, notBefore: null }).catch(() => undefined);
    else await this.ctx.api.releaseInstruction(res.instruction.id, { reason, notBefore: null }).catch(() => undefined);
  }

  private startRun(claim: ClaimOutput): void {
    const id = claim.kind === "thread" ? claim.thread.id : claim.instruction.id;
    const map = claim.kind === "thread" ? this.threads : claim.kind === "instruction" ? this.instructions : this.finalizes;
    if (map.has(id)) return;
    const controller = new AbortController();
    this.ctx.log.info("仕事を取り出しました", { kind: claim.kind, id });
    const promise = (async () => {
      try {
        let outcome: unknown;
        if (claim.kind === "thread") outcome = await (this.hooks.runThread ?? runThreadTurn)(this.ctx, claim, controller.signal);
        else if (claim.kind === "instruction") outcome = await (this.hooks.runInstruction ?? runInstructionPhase)(this.ctx, claim, controller.signal);
        else outcome = await (this.hooks.runFinalize ?? runFinalize)(this.ctx, claim);
        this.ctx.log.info("仕事が終わりました", { kind: claim.kind, id, outcome: String(outcome) });
      } catch (err) {
        this.ctx.log.error("仕事の処理で想定外のエラー", { kind: claim.kind, id, error: errorMessage(err) });
        if (!controller.signal.aborted) await this.releaseClaim(claim, "error");
      } finally {
        map.delete(id);
        if (!this.stopping) this.poke();
      }
    })();
    map.set(id, { kind: claim.kind, controller, promise, startedAt: Date.now() });
  }

  async heartbeat(): Promise<void> {
    if (this.stopping) return;
    if (this.heartbeating) {
      // 送っている最中に変わった分は、終わってからもう一度送る
      this.heartbeatAgain = true;
      return;
    }
    this.heartbeating = true;
    this.heartbeatAgain = false;
    try {
      const profiles = await this.ctx.profiles().catch(() => null);
      const out = await this.ctx.api.heartbeat(
        {
          version: this.ctx.config.version,
          tailnetUrl: this.ctx.config.tailnetUrl,
          activeInstructionIds: this.activeInstructionIds().slice(0, 16),
          activeSessionIds: this.activeSessionIds().slice(0, 16),
          activeThreadIds: this.activeThreadIds().slice(0, 16),
          quota: this.ctx.quota.refresh(),
          claudeVersion: this.ctx.auth.claudeVersion,
          claudeAuth: this.ctx.auth.tripped ? "not_subscription" : this.ctx.auth.authState,
          profiles: profiles ? profileViews(profiles) : [],
        },
        { signal: this.lifecycle.signal },
      );
      this.lastHeartbeatAt = Date.now();
      for (const id of out.cancelInstructionIds) this.cancel(id);
      for (const id of out.interruptSessionIds) this.interruptSession(id);
      for (const id of out.interruptThreadIds) this.ctx.threads.interrupt(id);
    } catch (err) {
      if (!this.stopping) this.ctx.log.warn("ハートビートに失敗", { error: errorMessage(err) });
    } finally {
      this.heartbeating = false;
    }
    if (this.heartbeatAgain && !this.stopping) {
      this.heartbeatAgain = false;
      await this.heartbeat();
    }
  }

  /** 停止（5.7）: 全プロセスに interrupt → lease を外す → deadlineMs で打ち切り（打ち切られても lease 切れで回収される） */
  async shutdown(deadlineMs = 5000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.unsubscribeQuota?.();
    this.lifecycle.abort(new StopSignal("shutdown"));
    const all = [...this.threads.values(), ...this.instructions.values(), ...this.finalizes.values()];
    for (const a of [...this.threads.values(), ...this.instructions.values()]) a.controller.abort(new StopSignal("shutdown"));
    const deadline = AbortSignal.timeout(Math.max(100, deadlineMs - 250));
    const releases = [
      ...[...this.threads.keys()].map((id) => this.ctx.api.releaseThread(id, { reason: "shutdown", notBefore: null }, { signal: deadline }).catch(() => undefined)),
      ...[...this.instructions.entries()]
        .filter(([, a]) => !(a.controller.signal.reason instanceof StopSignal && a.controller.signal.reason.reason === "cancel"))
        .map(([id]) => this.ctx.api.releaseInstruction(id, { reason: "shutdown", notBefore: null }, { signal: deadline }).catch(() => undefined)),
    ];
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(100, deadlineMs - 100));
      t.unref?.();
    });
    await Promise.race([Promise.allSettled([...releases, ...all.map((a) => a.promise), this.ctx.threads.closeAll()]), timeout]);
  }
}

/** ハートビートを早めに送るかどうかを決める枠の状態（利用率の細かな変化では送らない） */
function quotaKey(q: { status: string; paused: boolean; blockedUntil: number | null }): string {
  return `${q.status}|${q.paused}|${q.blockedUntil ?? ""}`;
}
