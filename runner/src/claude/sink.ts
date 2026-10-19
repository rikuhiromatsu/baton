// トランスクリプトとストリームの送り先（DESIGN-v2 4.7・8.4）。
// - トランスクリプト: 300ms / 50 件・512KB ごとに POST /api/runner/transcript。1 セッション 5,000・1 指示 20,000 の上限
// - ストリーム: 100ms ごとに POST /api/runner/threads/:id/stream（D1 に書かない。失敗は捨てる）
// - tailnet の生ログ（/sessions/:id/stream）にも流す
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  applySessionBudget,
  keepUnderInstructionBudget,
  type AppendTranscriptItemInput,
  type TranscriptDraft,
} from "@baton/shared";
import type { BatonApi } from "../api.ts";
import type { LiveLog, Logger } from "../log.ts";

/** 指示ごとの項目数（1 指示 20,000 の上限のため。ランナーのプロセス内で数える） */
const instructionCounts = new Map<string, number>();

export class TranscriptSink {
  private seq: number;
  private count = 0;
  private buffer: AppendTranscriptItemInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  instructionId: string | null;

  private readonly deps: { api: BatonApi; log: Logger; liveLog?: LiveLog; flushMs: number; summaryOnly?: boolean; now?: () => number };
  readonly sessionId: string;
  readonly threadId: string | null;

  constructor(
    deps: { api: BatonApi; log: Logger; liveLog?: LiveLog; flushMs: number; summaryOnly?: boolean; now?: () => number },
    sessionId: string,
    threadId: string | null,
    instructionId: string | null,
    startSeq = 0,
  ) {
    this.deps = deps;
    this.sessionId = sessionId;
    this.threadId = threadId;
    this.seq = startSeq;
    this.instructionId = instructionId;
  }

  get lastSeq(): number {
    return this.seq;
  }

  add(draft: TranscriptDraft, instructionId: string | null = this.instructionId): void {
    let d = applySessionBudget(draft, this.count);
    if (this.deps.summaryOnly && (d.kind === "tool_result" || d.kind === "thinking")) d = { ...d, body: {}, truncated: true };
    if (instructionId) {
      const n = instructionCounts.get(instructionId) ?? 0;
      if (!keepUnderInstructionBudget(d, n)) return;
      instructionCounts.set(instructionId, n + 1);
    }
    this.count += 1;
    this.seq += 1;
    const item: AppendTranscriptItemInput = {
      id: randomUUID(),
      sessionId: this.sessionId,
      threadId: this.threadId,
      instructionId,
      seq: this.seq,
      kind: d.kind,
      author: d.author,
      toolName: d.toolName?.slice(0, 100) ?? null,
      toolUseId: d.toolUseId?.slice(0, 100) ?? null,
      parentToolUseId: d.parentToolUseId?.slice(0, 100) ?? null,
      summary: d.summary.slice(0, LIMITS.summaryMaxChars),
      body: d.body,
      truncated: d.truncated,
      isError: d.isError,
      createdAt: (this.deps.now ?? Date.now)(),
    };
    this.deps.liveLog?.append(this.sessionId, "item", item);
    this.buffer.push(item);
    if (this.buffer.length >= LIMITS.transcriptPerPost) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.deps.flushMs);
      this.timer.unref?.();
    }
  }

  /** 溜まっているものを送る（順番を守るため直列） */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = this.buffer.splice(0);
    if (items.length === 0) return this.flushing;
    this.flushing = this.flushing.then(async () => {
      // 512KB を超えないように分ける
      let chunk: AppendTranscriptItemInput[] = [];
      let bytes = 0;
      const send = async () => {
        if (!chunk.length) return;
        const c = chunk;
        chunk = [];
        bytes = 0;
        try {
          await this.deps.api.appendTranscript({ items: c });
        } catch (err) {
          this.deps.log.warn("トランスクリプトを送れません（捨てます）", { sessionId: this.sessionId, error: (err as Error).message });
        }
      };
      for (const it of items) {
        const size = Buffer.byteLength(JSON.stringify(it));
        if (chunk.length >= LIMITS.transcriptPerPost || bytes + size > LIMITS.transcriptPostBytes) await send();
        chunk.push(it);
        bytes += size;
      }
      await send();
    });
    return this.flushing;
  }
}

/** スレッドの返事のストリーミング（4.7）。text を溜めて 100ms ごとに送る */
export class StreamSink {
  private offset = 0;
  private pending = "";
  private pendingReset = false;
  private activity: string | null | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** これまでに送った本文（reset で空に戻る） */
  text = "";

  private readonly deps: { api: BatonApi; flushMs: number };
  readonly threadId: string;
  readonly messageId: string;

  constructor(deps: { api: BatonApi; flushMs: number }, threadId: string, messageId: string) {
    this.deps = deps;
    this.threadId = threadId;
    this.messageId = messageId;
  }

  append(delta: string): void {
    this.pending += delta;
    this.text += delta;
    this.schedule();
  }

  reset(): void {
    this.pending = "";
    this.text = "";
    this.pendingReset = true;
    this.schedule();
  }

  setActivity(activity: string | null): void {
    if (this.activity === activity) return;
    this.activity = activity;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.flushMs);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const reset = this.pendingReset;
    const activity = this.activity;
    this.activity = undefined;
    this.pendingReset = false;
    let delta = this.pending;
    this.pending = "";
    if (!reset && !delta && activity === undefined) return this.chain;
    if (reset) this.offset = 0;
    const parts: string[] = [];
    while (delta.length > LIMITS.streamDeltaMaxChars) {
      parts.push(delta.slice(0, LIMITS.streamDeltaMaxChars));
      delta = delta.slice(LIMITS.streamDeltaMaxChars);
    }
    parts.push(delta);
    this.chain = this.chain.then(async () => {
      let first = true;
      for (const p of parts) {
        const offset = this.offset;
        this.offset += p.length;
        try {
          await this.deps.api.stream(this.threadId, {
            messageId: this.messageId,
            offset,
            delta: p,
            ...(first && reset ? { reset: true } : {}),
            ...(first && activity !== undefined ? { activity: activity?.slice(0, LIMITS.summaryMaxChars) ?? null } : {}),
          });
        } catch {
          // ストリームは捨ててよい（完成した本文は REST で届く）
        }
        first = false;
      }
    });
    return this.chain;
  }
}
