// ランナー全体で共有する部品（API・設定・ログ・枠・プロファイル・認証の守り・承認の待ち合わせ・プロセスの空き）。
import type { Decision, Workspace } from "@baton/shared";
import type { BatonApi } from "./api.ts";
import type { JevClient } from "./claude/jev.ts";
import type { ResolvedProfiles } from "./claude/profiles.ts";
import type { RunnerConfig } from "./config.ts";
import type { LiveLog, Logger } from "./log.ts";
import type { QuotaGate } from "./quota.ts";
import type { ThreadPool } from "./orchestrator/thread-pool.ts";
import type { StateStore } from "./state.ts";
import { type Semaphore, sleep } from "./sync.ts";

/** サブスク以外の認証・MCP の漏れで止まった（7.7）。以後の起動を止める */
export class AuthGuard {
  tripped: string | null = null;
  authState: "ok" | "not_logged_in" | "not_subscription" | "unknown" = "unknown";
  claudeVersion: string | null = null;
  trip(reason: string): void {
    this.tripped ??= reason;
    this.authState = "not_subscription";
  }
  get canStart(): boolean {
    return this.tripped === null && this.authState !== "not_logged_in" && this.authState !== "not_subscription";
  }
}

/** decision.answered を待つ（WebSocket の合図。取りこぼしに備えて間隔をあけて取りにいく） */
export class DecisionWaiters {
  private readonly waiters = new Map<string, Set<() => void>>();

  notify(decisionId: string): void {
    for (const w of this.waiters.get(decisionId) ?? []) w();
  }

  async wait(api: BatonApi, decisionId: string, timeoutMs: number, signal: AbortSignal, pollMs = 15_000): Promise<Decision | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason;
      let wake: () => void = () => undefined;
      const poked = new Promise<void>((r) => (wake = r));
      let set = this.waiters.get(decisionId);
      if (!set) {
        set = new Set();
        this.waiters.set(decisionId, set);
      }
      set.add(wake);
      try {
        await Promise.race([poked, sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal)]);
      } finally {
        set.delete(wake);
        if (set.size === 0) this.waiters.delete(decisionId);
      }
      if (signal.aborted) throw signal.reason;
      try {
        const d = await api.getDecision(decisionId, { signal });
        if (d.status !== "open") return d;
      } catch {
        // 次の合図・間隔で取り直す
      }
    }
    return null;
  }
}

export type RunnerContext = {
  api: BatonApi;
  config: RunnerConfig;
  log: Logger;
  liveLog: LiveLog;
  quota: QuotaGate;
  auth: AuthGuard;
  decisions: DecisionWaiters;
  /** 起動のたびに読み直す（本人が profiles.local.json を直せば次の起動から効く） */
  profiles: () => Promise<ResolvedProfiles>;
  state: StateStore;
  /** メンバーのモデルとエフォートを決める Jev（5.9.1）。テストは偽の Jev を入れる */
  jev: JevClient;
  coord: Coordination;
  threads: ThreadPool;
  memberSlots: Semaphore;
  now: () => number;
};

/** スレッドと指示のあいだの待ち合わせ（プロセス内） */
export class Coordination {
  /** メンバーの質問の答え（answer_member）を待っているセッション */
  readonly memberAnswers = new Map<string, (text: string) => void>();
  /** 話し中で保留した COO の present・relay があるプロジェクト（D-79） */
  readonly heldProjects = new Set<string>();
  /** 動いているメンバーのセッション（追加の依頼・中断の行き先） */
  readonly memberSessions = new Map<string, { inject: (text: string) => boolean; interrupt: () => void; instructionId: string }>();

  /** 見たことのある作業場所（tailnet の /diff/:workspaceId） */
  readonly workspaces = new Map<string, Workspace>();

  answerMember(sessionId: string, text: string): boolean {
    const fn = this.memberAnswers.get(sessionId);
    if (!fn) return false;
    this.memberAnswers.delete(sessionId);
    fn(text);
    return true;
  }
}
