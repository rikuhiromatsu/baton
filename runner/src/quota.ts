// サブスク枠の見張り（DESIGN-v2 9 章、D-55）。全プロセスの rate_limit_event と result の枠切れの文を集める。
// - 5 時間枠 ≥ 0.80 か週の枠 ≥ 0.90: メンバーのセッションを新しく起動しない（スレッドのターンは続ける）
// - rejected / You've hit your … limit: blockedUntil（resetsAt + 60 秒、無ければ 30 分後）まで新しいターンを始めない
import {
  EMPTY_QUOTA,
  LIMITS,
  applyQuotaObservation,
  canStartMemberSession,
  canStartThreadTurn,
  isOverThreshold,
  type QuotaObservation,
  type QuotaStatus,
} from "@baton/shared";

export class QuotaGate {
  private status: QuotaStatus = { ...EMPTY_QUOTA };
  private readonly listeners = new Set<(q: QuotaStatus) => void>();

  private readonly now: () => number;
  private readonly marginMs: number;
  constructor(now: () => number = Date.now, marginMs: number = LIMITS.quotaResumeMarginMs) {
    this.now = now;
    this.marginMs = marginMs;
  }

  get current(): QuotaStatus {
    return this.status;
  }

  onChange(fn: (q: QuotaStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  observe(obs: QuotaObservation): void {
    const next = applyQuotaObservation(this.status, obs, this.now());
    // 戻る時刻の余裕は設定で変えられる（BATON_QUOTA_RESUME_MARGIN_MS。E2E は短く）
    if (obs.status === "rejected" && obs.resetsAt !== null) next.blockedUntil = obs.resetsAt + this.marginMs;
    this.set(next);
  }

  /** result の本文が枠切れの文だった */
  limitHit(): void {
    this.set(applyQuotaObservation(this.status, { status: "rejected", limitHit: true }, this.now()));
  }

  private set(next: QuotaStatus): void {
    this.status = next;
    for (const l of this.listeners) l(next);
  }

  /** 期限を過ぎたら blockedUntil を外す（claim の前に呼ぶ） */
  refresh(): QuotaStatus {
    const q = this.status;
    if (q.blockedUntil !== null && this.now() >= q.blockedUntil) {
      this.set({ ...q, blockedUntil: null, status: q.status === "rejected" ? "unknown" : q.status, rejectedType: null, paused: isOverThreshold(q) });
    }
    return this.status;
  }

  canStartThreadTurn(): boolean {
    return canStartThreadTurn(this.refresh(), this.now());
  }
  canStartMember(): boolean {
    return canStartMemberSession(this.refresh(), this.now());
  }
  get blockedUntil(): number | null {
    return this.refresh().blockedUntil;
  }
}
