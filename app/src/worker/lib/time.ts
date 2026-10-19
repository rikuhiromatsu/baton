// 時刻の小道具。時刻はすべて UNIX ミリ秒

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Asia/Tokyo の今日の 0 時（推定額の「今日」の集計に使う） */
export function startOfTokyoDay(ms: number): number {
  const offset = 9 * 60 * 60 * 1000;
  return Math.floor((ms + offset) / DAY_MS) * DAY_MS - offset;
}
