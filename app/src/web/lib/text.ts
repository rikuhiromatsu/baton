// 表示用の文字列処理（文言は足さない）
import type { InstructionSummary } from "@baton/shared";

export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
}

export function cardTitle(item: Pick<InstructionSummary, "title" | "body">): string {
  return item.title?.trim() || firstLine(item.body);
}

/** 「上限: 〇〇」の形なら、前置の固定文言と残りに分ける（7.11） */
export function splitLimitError(error: string): { limit: boolean; rest: string } {
  const m = error.match(/^上限\s*[:：]\s*(.*)$/s);
  return m ? { limit: true, rest: m[1]!.trim() } : { limit: false, rest: error };
}
