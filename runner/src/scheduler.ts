// 指示の取り出し（claim）と同時実行、ハートビート（設計書 5.6、D-3）。
// - claim は 15 秒ごと＋WebSocket の work.available / decision.answered で即時
// - 同時実行は 2（設定で変更可）
// - 30 秒ごとのハートビートで lease を延ばし、中止すべき指示を受け取る
// - 停止（SIGTERM）: 実行中の指示を止めて release { reason: "shutdown" } してから戻る（5 秒で打ち切り）
import type { ClaimOutput } from "@baton/shared";
import type { BatonApi } from "./api.ts";
import type { RunnerConfig } from "./config.ts";
import { StopSignal, errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";

export type RunFn = (claim: ClaimOutput, signal: AbortSignal) => Promise<unknown>;

type Active = { controller: AbortController; promise: Promise<void>; startedAt: number };

export class Scheduler {
  private readonly api: BatonApi;
  private readonly config: RunnerConfig;
  private readonly run: RunFn;
  private readonly log: Logger;
  private readonly active = new Map<string, Active>();
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private claiming = false;
  private claimAgain = false;
  private heartbeating = false;
  private stopping = false;
  private readonly lifecycle = new AbortController();
  lastHeartbeatAt: number | null = null;
  lastClaimError: string | null = null;

  constructor(opts: { api: BatonApi; config: RunnerConfig; run: RunFn; log: Logger }) {
    this.api = opts.api;
    this.config = opts.config;
    this.run = opts.run;
    this.log = opts.log;
  }

  get maxConcurrent(): number {
    return this.config.limits.runnerConcurrentInstructions;
  }

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  start(): void {
    this.claimTimer = setInterval(() => this.poke(), this.config.limits.claimPollIntervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.config.limits.heartbeatIntervalMs);
    void this.heartbeat();
    this.poke();
  }

  /** 仕事があるかもしれない（WebSocket の通知・タイマー・処理の終了） */
  poke(): void {
    if (this.stopping) return;
    void this.claimLoop();
  }

  /** 指示の取消（WebSocket の instruction.cancel・ハートビートの応答） */
  cancel(instructionId: string): void {
    const a = this.active.get(instructionId);
    if (!a || a.controller.signal.aborted) return;
    this.log.info("取消を受けました。処理を止めます", { instructionId });
    a.controller.abort(new StopSignal("cancel"));
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
        while (!this.stopping && this.active.size < this.maxConcurrent) {
          let res: ClaimOutput | null;
          try {
            res = await this.api.claim({ maxConcurrent: this.maxConcurrent, activeIds: this.activeIds() }, { signal: this.lifecycle.signal });
            this.lastClaimError = null;
          } catch (err) {
            if (!this.stopping) {
              this.lastClaimError = errorMessage(err);
              this.log.warn("claim に失敗", { error: errorMessage(err) });
            }
            return;
          }
          if (!res) break;
          if (this.stopping) {
            // 停止中に取れてしまったものはすぐ返す
            await this.api.release(res.instruction.id, { reason: "shutdown", notBefore: null }).catch(() => undefined);
            return;
          }
          this.startRun(res);
        }
      } while (this.claimAgain && !this.stopping);
    } finally {
      this.claiming = false;
    }
  }

  private startRun(claim: ClaimOutput): void {
    const id = claim.instruction.id;
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.log.info("指示を取り出しました", { instructionId: id, resume: claim.resume });
    const promise = (async () => {
      try {
        const outcome = await this.run(claim, controller.signal);
        this.log.info("指示の処理が終わりました", { instructionId: id, outcome: String(outcome) });
      } catch (err) {
        this.log.error("指示の処理で想定外のエラー", { instructionId: id, error: errorMessage(err) });
      } finally {
        this.active.delete(id);
        if (!this.stopping) this.poke();
      }
    })();
    this.active.set(id, { controller, promise, startedAt: Date.now() });
  }

  async heartbeat(): Promise<void> {
    if (this.heartbeating || this.stopping) return;
    this.heartbeating = true;
    try {
      const out = await this.api.heartbeat(
        {
          version: this.config.version,
          tailnetUrl: this.config.tailnetUrl,
          activeInstructionIds: this.activeIds().slice(0, 8),
          maxConcurrent: this.maxConcurrent,
        },
        { signal: this.lifecycle.signal },
      );
      this.lastHeartbeatAt = Date.now();
      for (const id of out.cancelInstructionIds) this.cancel(id);
    } catch (err) {
      if (!this.stopping) this.log.warn("ハートビートに失敗", { error: errorMessage(err) });
    } finally {
      this.heartbeating = false;
    }
  }

  /**
   * 停止。タイマーを止め、実行中の指示を中断して release { reason: "shutdown" } する。
   * deadlineMs で打ち切る（打ち切られても lease 切れで回収される）。
   */
  async shutdown(deadlineMs = 5000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.lifecycle.abort(new StopSignal("shutdown"));

    const entries = [...this.active.entries()];
    for (const [, a] of entries) a.controller.abort(new StopSignal("shutdown"));
    const deadline = AbortSignal.timeout(Math.max(100, deadlineMs - 250));
    const releases = entries.map(async ([id, a]) => {
      // 取消で止めたもの（canceled）は release しない
      const reason: unknown = a.controller.signal.reason;
      if (reason instanceof StopSignal && reason.reason === "cancel") return;
      try {
        await this.api.release(id, { reason: "shutdown", notBefore: null }, { signal: deadline });
        this.log.info("停止のため指示を返しました", { instructionId: id });
      } catch (err) {
        this.log.warn("停止時の release に失敗（lease 切れで回収されます）", { instructionId: id, error: errorMessage(err) });
      }
    });
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(100, deadlineMs - 100));
      t.unref?.();
    });
    await Promise.race([Promise.allSettled([...releases, ...entries.map(([, a]) => a.promise)]), timeout]);
  }
}
