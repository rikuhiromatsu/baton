// 待機とセマフォ。どちらも AbortSignal で止まる。

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 中止されたら reject する Promise。待機の競争に使う */
export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export class Semaphore {
  private available: number;
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
    this.available = size;
  }

  get inUse(): number {
    return this.size - this.available;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason;
    if (this.available > 0) {
      this.available--;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
    return this.releaser();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        next.resolve();
      } else {
        this.available++;
      }
    };
  }
}
