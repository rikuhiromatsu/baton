// 指示カードの並び（v1 7.3・DESIGN-v2 13.8）。開いた判断のある running は「判断待ち」のまとまり（displayGroup）
import { HOME_STATUS_ORDER, RECENT_DAYS_FOR_CLOSED, displayGroup, type InstructionStatus, type InstructionSummary } from "@baton/shared";

const DAY = 24 * 60 * 60 * 1000;
export type HomeStatus = (typeof HOME_STATUS_ORDER)[number];
export type HomeGroup = { status: HomeStatus; items: InstructionSummary[] };

const CLOSED: readonly InstructionStatus[] = ["done", "canceled"];

/** done と canceled は直近 7 日だけ出す */
export function isVisibleOnHome(item: InstructionSummary, now: number): boolean {
  if (item.status === "archived") return false;
  if (CLOSED.includes(item.status)) return item.statusChangedAt >= now - RECENT_DAYS_FOR_CLOSED * DAY;
  return true;
}

export function byStatusChangedDesc(a: InstructionSummary, b: InstructionSummary): number {
  return b.statusChangedAt - a.statusChangedAt || b.createdAt - a.createdAt;
}

/** まとまりごとに分けて並べる。空のまとまりは返さない。projectId を渡すとそのプロジェクトだけ */
export function groupForHome(items: readonly InstructionSummary[], now: number, projectId: string | null = null): HomeGroup[] {
  const buckets = new Map<HomeStatus, InstructionSummary[]>();
  for (const item of items) {
    if (!isVisibleOnHome(item, now)) continue;
    if (projectId && item.projectId !== projectId) continue;
    const status = displayGroup(item) as HomeStatus;
    const list = buckets.get(status);
    if (list) list.push(item);
    else buckets.set(status, [item]);
  }
  const groups: HomeGroup[] = [];
  for (const status of HOME_STATUS_ORDER) {
    const list = buckets.get(status);
    if (list && list.length > 0) groups.push({ status, items: list.sort(byStatusChangedDesc) });
  }
  return groups;
}

/** アーカイブは片付けた新しい順 */
export function sortArchived(items: readonly InstructionSummary[]): InstructionSummary[] {
  return items.filter((i) => i.status === "archived").sort(byStatusChangedDesc);
}
