// 時刻の小道具。時刻はすべて UNIX ミリ秒。日付の集計だけ UTC の YYYY-MM-DD（設計書 3.2）

export const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 次の UTC 0 時（Workers AI の無料枠が戻る時刻） */
export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
