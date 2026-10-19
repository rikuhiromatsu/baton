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
    // rate_limit_event で戻る時刻が分かっていればそれを使う（無ければ 30 分後。9.2）
    const known = this.status.blockedUntil;
    const next = applyQuotaObservation(this.status, { status: "rejected", limitHit: true }, this.now());
    if (known !== null && known > this.now()) next.blockedUntil = known;
    this.set(next);
  }

  private set(next: QuotaStatus): void {
    this.status = next;
    for (const l of this.listeners) l(next);
  }

  /** 期限を過ぎたら blockedUntil を外す（claim の前に呼ぶ） */
  refresh(): QuotaStatus {
    const now = this.now();
    let q = this.status;
    let changed = false;
    // 戻る時刻を過ぎた枠の利用率は古いので捨てる（次の rate_limit_event で入り直す）
    const fresh = (w: QuotaStatus["fiveHour"]) => (w.resetsAt !== null && now >= w.resetsAt ? ((changed = true), { utilization: null, resetsAt: null }) : w);
    q = { ...q, fiveHour: fresh(q.fiveHour), sevenDay: fresh(q.sevenDay) };
    if (q.blockedUntil !== null && now >= q.blockedUntil) {
      q = { ...q, blockedUntil: null, status: q.status === "rejected" ? "unknown" : q.status, rejectedType: null };
      changed = true;
    }
    if (changed) this.set({ ...q, paused: q.blockedUntil !== null || isOverThreshold(q) });
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
