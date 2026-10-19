// F5 並び順（7.3）と 7 日の打ち切り
import { describe, expect, it } from "vitest";
import { HOME_STATUS_ORDER, type InstructionStatus } from "@baton/shared";
import { groupForHome, isVisibleOnHome, sortArchived } from "../../src/web/lib/sort.ts";
import { summary } from "./helpers.tsx";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("F5 並び順", () => {
  it("まとまりは 判断待ち → 確認 → 実行中 → 待機 → 失敗 → 取消 → 完了 の順", () => {
    const statuses: InstructionStatus[] = ["done", "queued", "canceled", "review", "failed", "needs_decision", "running"];
    const items = statuses.map((s, i) => summary({ status: s, statusChangedAt: NOW - i * 1000 }));
    const groups = groupForHome(items, NOW);
    expect(groups.map((g) => g.status)).toEqual([...HOME_STATUS_ORDER]);
  });

  it("まとまりの中は status_changed_at の新しい順", () => {
    const a = summary({ status: "review", statusChangedAt: NOW - 3000 });
    const b = summary({ status: "review", statusChangedAt: NOW - 1000 });
    const c = summary({ status: "review", statusChangedAt: NOW - 2000 });
    const [g] = groupForHome([a, b, c], NOW);
    expect(g!.items.map((i) => i.id)).toEqual([b.id, c.id, a.id]);
  });

  it("完了と取消は直近 7 日だけ。ほかの状態は古くても出す。アーカイブは出さない", () => {
    const fresh = summary({ status: "done", statusChangedAt: NOW - 7 * DAY + 1 });
    const edge = summary({ status: "canceled", statusChangedAt: NOW - 7 * DAY });
    const old = summary({ status: "done", statusChangedAt: NOW - 7 * DAY - 1 });
    const oldCanceled = summary({ status: "canceled", statusChangedAt: NOW - 30 * DAY });
    const oldFailed = summary({ status: "failed", statusChangedAt: NOW - 30 * DAY });
    const oldQueued = summary({ status: "queued", statusChangedAt: NOW - 30 * DAY });
    const archived = summary({ status: "archived", statusChangedAt: NOW });
    expect(isVisibleOnHome(fresh, NOW)).toBe(true);
    expect(isVisibleOnHome(edge, NOW)).toBe(true);
    expect(isVisibleOnHome(old, NOW)).toBe(false);
    expect(isVisibleOnHome(oldCanceled, NOW)).toBe(false);
    expect(isVisibleOnHome(oldFailed, NOW)).toBe(true);
    expect(isVisibleOnHome(oldQueued, NOW)).toBe(true);
    expect(isVisibleOnHome(archived, NOW)).toBe(false);
    const ids = groupForHome([fresh, edge, old, oldCanceled, oldFailed, oldQueued, archived], NOW).flatMap((g) => g.items.map((i) => i.id));
    expect(ids.sort()).toEqual([fresh.id, edge.id, oldFailed.id, oldQueued.id].sort());
  });

  it("空のまとまりは返さない", () => {
    expect(groupForHome([], NOW)).toEqual([]);
    expect(groupForHome([summary({ status: "running" })], NOW).map((g) => g.status)).toEqual(["running"]);
  });

  it("アーカイブは片付けた新しい順", () => {
    const a = summary({ status: "archived", statusChangedAt: NOW - 2 * DAY });
    const b = summary({ status: "archived", statusChangedAt: NOW - DAY });
    expect(sortArchived([a, b]).map((i) => i.id)).toEqual([b.id, a.id]);
  });
});
