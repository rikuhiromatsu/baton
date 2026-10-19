// 1 回の実行（attempt）あたりの上限（設計書 5.6）。AI 呼び出し回数・トークン・経過時間。
// 上限は attempt ごとにリセットされる（CEO が再実行すると最初から数える）。
import { LimitError } from "../errors.ts";

export type BudgetLimits = {
  aiCallsPerInstruction: number;
  tokensPerInstruction: number;
  instructionWallClockMs: number;
};

export class Budget {
  private readonly limits: BudgetLimits;
  private readonly now: () => number;
  readonly startedAt: number;
  aiCalls = 0;
  tokensIn = 0;
  tokensOut = 0;

  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.startedAt = now();
  }

  get tokens(): number {
    return this.tokensIn + this.tokensOut;
  }

  /** 経過時間の上限 */
  checkTime(): void {
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.limits.instructionWallClockMs) {
      throw new LimitError(`経過時間（${Math.round(this.limits.instructionWallClockMs / 60000)} 分）`);
    }
  }

  /** AI を呼ぶ前に。回数・トークン・時間のどれかが尽きていたら LimitError */
  beforeAiCall(): void {
    this.checkTime();
    if (this.aiCalls >= this.limits.aiCallsPerInstruction) {
      throw new LimitError(`AI 呼び出し回数（${this.limits.aiCallsPerInstruction} 回）`);
    }
    if (this.tokens >= this.limits.tokensPerInstruction) {
      throw new LimitError(`トークン（${this.limits.tokensPerInstruction.toLocaleString("ja-JP")}）`);
    }
    this.aiCalls++;
  }

  addUsage(tokensIn: number, tokensOut: number): void {
    this.tokensIn += Math.max(0, tokensIn);
    this.tokensOut += Math.max(0, tokensOut);
  }
}
