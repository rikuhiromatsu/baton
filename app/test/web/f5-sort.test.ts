// F5 並び順（v1 7.3）と 7 日の打ち切り。v2 は判断待ちのまとまり（displayGroup）とプロジェクトでの絞り込み
import { describe, expect, it } from "vitest";
import { groupForHome, isVisibleOnHome, sortArchived } from "../../src/web/lib/sort.ts";
import { summary } from "./helpers.tsx";

const DAY = 24 * 60 * 60 * 1000;

describe("F5 並び順", () => {
  it("判断待ち → 確認 → 実行中 → 待機 → 失敗 → 取消 → 完了 の順、中は新しい順", () => {
    const now = Date.now();
    const items = [
      summary({ status: "done", statusChangedAt: now - 1000 }),
      summary({ status: "running", statusChangedAt: now - 3000 }),
      summary({ status: "running", statusChangedAt: now - 1000 }),
      summary({ status: "review", statusChangedAt: now }),
      summary({ status: "queued" }),
      summary({ status: "failed" }),
      summary({ status: "canceled" }),
      summary({ status: "needs_decision" }),
    ];
    const groups = groupForHome(items, now);
    expect(groups.map((g) => g.status)).toEqual(["needs_decision", "review", "running", "queued", "failed", "canceled", "done"]);
    const running = groups.find((g) => g.status === "running")!.items;
    expect(running[0]!.statusChangedAt).toBeGreaterThan(running[1]!.statusChangedAt);
  });

  it("開いた判断（承認）のある running は判断待ちのまとまりに出る", () => {
    const now = Date.now();
    const groups = groupForHome([summary({ status: "running", openDecisionCount: 1 }), summary({ status: "running" })], now);
    expect(groups.map((g) => [g.status, g.items.length])).toEqual([
      ["needs_decision", 1],
      ["running", 1],
    ]);
  });

  it("完了と取消は 7 日まで、アーカイブは出さない", () => {
    const now = Date.now();
    expect(isVisibleOnHome(summary({ status: "done", statusChangedAt: now - 6 * DAY }), now)).toBe(true);
    expect(isVisibleOnHome(summary({ status: "done", statusChangedAt: now - 8 * DAY }), now)).toBe(false);
    expect(isVisibleOnHome(summary({ status: "canceled", statusChangedAt: now - 8 * DAY }), now)).toBe(false);
    expect(isVisibleOnHome(summary({ status: "archived" }), now)).toBe(false);
  });

  it("プロジェクトを選んでいるときはそのプロジェクトのカードだけ", () => {
    const now = Date.now();
    const groups = groupForHome([summary({ status: "running", projectId: "a" }), summary({ status: "running", projectId: "b" })], now, "a");
    expect(groups.flatMap((g) => g.items.map((i) => i.projectId))).toEqual(["a"]);
  });

  it("アーカイブは片付けた新しい順", () => {
    const now = Date.now();
    const a = summary({ status: "archived", statusChangedAt: now - 10 });
    const b = summary({ status: "archived", statusChangedAt: now });
    expect(sortArchived([a, b, summary({ status: "done" })]).map((i) => i.id)).toEqual([b.id, a.id]);
  });
});
