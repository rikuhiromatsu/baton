// スレッド（COO・リーダー）のプロセスの置き場（DESIGN-v2 5.3・5.8、D-43）。
// result のあと BATON_THREAD_IDLE_MS（120 秒）は生かし、その間の次のターンは同じプロセスに流し込む。過ぎたら標準入力を閉じる。
// 同時に持つのは threadProcesses（2）まで。待機中のプロセスも数え、足りなければ一番古い待機中を閉じる。
import type { AgentSession } from "../claude/session.ts";

type Entry = { threadId: string; session: AgentSession; busy: boolean; idleTimer: ReturnType<typeof setTimeout> | null; lastUsed: number };

export class ThreadPool {
  private readonly entries = new Map<string, Entry>();
  private reserved = 0;

  private readonly capacity: number;
  private readonly idleMs: number;
  constructor(capacity: number, idleMs: number) {
    this.capacity = capacity;
    this.idleMs = idleMs;
  }

  get size(): number {
    return this.entries.size + this.reserved;
  }

  /** 新しいターンを始められるか（空きがあるか、閉じられる待機中があるか、そのスレッドの待機中があるか） */
  hasRoom(threadId?: string): boolean {
    if (threadId && this.entries.has(threadId) && !this.entries.get(threadId)!.busy) return true;
    if (this.size < this.capacity) return true;
    return [...this.entries.values()].some((e) => !e.busy);
  }

  activeThreadIds(): string[] {
    return [...this.entries.values()].filter((e) => e.busy).map((e) => e.threadId);
  }

  sessionIds(): string[] {
    return [...this.entries.values()].map((e) => e.session.sessionId);
  }

  get(threadId: string): AgentSession | null {
    return this.entries.get(threadId)?.session ?? null;
  }

  /** 待機中のプロセスをそのスレッドのターンに使う（セッション ID が違えば閉じて null） */
  async take(threadId: string, sessionId: string | null): Promise<AgentSession | null> {
    const e = this.entries.get(threadId);
    if (!e) return null;
    if (e.idleTimer) clearTimeout(e.idleTimer);
    e.idleTimer = null;
    if (!e.session.alive || (sessionId !== null && e.session.sessionId !== sessionId)) {
      this.entries.delete(threadId);
      await e.session.close({ interrupt: true }).catch(() => undefined);
      return null;
    }
    e.busy = true;
    e.lastUsed = Date.now();
    return e.session;
  }

  /** 新しいプロセスの枠を取る（足りなければ一番古い待機中を閉じる） */
  async reserve(): Promise<boolean> {
    while (this.size >= this.capacity) {
      const idle = [...this.entries.values()].filter((e) => !e.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return false;
      this.entries.delete(idle.threadId);
      if (idle.idleTimer) clearTimeout(idle.idleTimer);
      await idle.session.close({ interrupt: false }).catch(() => undefined);
    }
    this.reserved += 1;
    return true;
  }

  unreserve(): void {
    this.reserved = Math.max(0, this.reserved - 1);
  }

  /** 予約した枠にプロセスを入れる（ターン中） */
  put(threadId: string, session: AgentSession): void {
    this.unreserve();
    this.entries.set(threadId, { threadId, session, busy: true, idleTimer: null, lastUsed: Date.now() });
  }

  /** ターンが終わった。待機に入れ、時間が来たら閉じる */
  idle(threadId: string): void {
    const e = this.entries.get(threadId);
    if (!e) return;
    e.busy = false;
    e.lastUsed = Date.now();
    if (!e.session.alive) {
      this.entries.delete(threadId);
      return;
    }
    e.idleTimer = setTimeout(() => {
      if (this.entries.get(threadId) !== e || e.busy) return;
      this.entries.delete(threadId);
      void e.session.close({ interrupt: false });
    }, this.idleMs);
    e.idleTimer.unref?.();
  }

  /** そのスレッドのプロセスを閉じる（失敗・新しい話題・停止） */
  async drop(threadId: string, opts: { interrupt?: boolean } = {}): Promise<void> {
    const e = this.entries.get(threadId);
    if (!e) return;
    this.entries.delete(threadId);
    if (e.idleTimer) clearTimeout(e.idleTimer);
    await e.session.close({ interrupt: opts.interrupt ?? true }).catch(() => undefined);
  }

  interrupt(threadId: string): boolean {
    const e = this.entries.get(threadId);
    if (!e || !e.busy) return false;
    e.session.interruptTurn();
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.drop(id, { interrupt: true })));
  }
}
