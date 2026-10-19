// F4 フリック判定の純粋関数（しきい値・速度・方向ロック・動けない方向）
import { describe, expect, it } from "vitest";
import { decideSwipe, lockAxis, resistOffset, swipeThreshold, SWIPE } from "../../src/web/lib/decideSwipe.ts";

const still = { x: 0, y: 0 };

describe("F4 decideSwipe", () => {
  it("しきい値は min(120px, 幅 × 0.32)", () => {
    expect(swipeThreshold(600)).toBe(120);
    expect(swipeThreshold(300)).toBeCloseTo(96);
    expect(swipeThreshold(375)).toBe(120);
  });

  it("距離がしきい値以上なら確定、未満なら戻る", () => {
    const w = 300; // しきい値 96
    expect(decideSwipe({ x: 96, y: 0 }, still, w, "review").commit).toBe(true);
    expect(decideSwipe({ x: 95, y: 0 }, still, w, "review").commit).toBe(false);
    expect(decideSwipe({ x: -130, y: 4 }, still, 400, "review")).toMatchObject({ commit: true, direction: "left", outcome: "send_back" });
  });

  it("速いフリック: 800px/s 以上かつ 40px 以上で確定", () => {
    const w = 400;
    expect(decideSwipe({ x: 40, y: 0 }, { x: 800, y: 0 }, w, "review").commit).toBe(true);
    expect(decideSwipe({ x: 39, y: 0 }, { x: 2000, y: 0 }, w, "review").commit).toBe(false);
    expect(decideSwipe({ x: 60, y: 0 }, { x: 799, y: 0 }, w, "review").commit).toBe(false);
    // 速度の向きが逆なら速いフリックとはみなさない
    expect(decideSwipe({ x: 60, y: 0 }, { x: -1200, y: 0 }, w, "review").commit).toBe(false);
    // しきい値を超えていても、逆向きに速く戻しているときは確定しない
    expect(decideSwipe({ x: 130, y: 0 }, { x: -900, y: 0 }, w, "review").commit).toBe(false);
  });

  it("方向ロック: 10px 動くまでは決めない。|dx| > |dy| × 1.5 なら横、そうでなければ縦", () => {
    expect(lockAxis(6, 6)).toBeNull();
    expect(lockAxis(9, 0)).toBeNull();
    expect(lockAxis(10, 0)).toBe("x");
    expect(lockAxis(16, 10)).toBe("x");
    expect(lockAxis(15, 10)).toBe("y");
    expect(lockAxis(3, -12)).toBe("y");
    // 縦と判定されたら距離があっても確定しない
    expect(decideSwipe({ x: 150, y: 120 }, { x: 1500, y: 0 }, 400, "review")).toMatchObject({ axis: "y", commit: false });
    // ドラッグ開始時に横と決めた向きを渡せば、それを使う
    expect(decideSwipe({ x: 150, y: 120 }, still, 400, "review", "x").commit).toBe(true);
  });

  it("その方向に動けない状態（SWIPE_MAP が null）は確定せず、重くなる", () => {
    const right = decideSwipe({ x: 200, y: 0 }, { x: 2000, y: 0 }, 400, "queued");
    expect(right).toMatchObject({ allowed: false, outcome: null, commit: false, pastThreshold: false });
    const left = decideSwipe({ x: -200, y: 0 }, still, 400, "done");
    expect(left).toMatchObject({ allowed: false, commit: false });
    expect(resistOffset(100, false)).toBeCloseTo(100 * SWIPE.blockedElastic);
    expect(resistOffset(100, true)).toBe(100);
  });

  it("状態ごとの操作は SWIPE_MAP（3.5）に従う", () => {
    const go = (status: Parameters<typeof decideSwipe>[3], dx: number) => decideSwipe({ x: dx, y: 0 }, still, 400, status).outcome;
    expect(go("queued", -200)).toBe("cancel");
    expect(go("running", -200)).toBe("cancel");
    expect(go("needs_decision", 200)).toBe("open_decision");
    expect(go("needs_decision", -200)).toBe("cancel");
    expect(go("review", 200)).toBe("approve");
    expect(go("done", 200)).toBe("archive");
    expect(go("failed", 200)).toBe("retry");
    expect(go("failed", -200)).toBe("archive");
    expect(go("canceled", 200)).toBe("retry");
    expect(go("archived", 200)).toBe("restore");
    expect(go("archived", -200)).toBeNull();
  });

  it("動いていないときは何もしない", () => {
    expect(decideSwipe(still, still, 400, "review")).toMatchObject({ axis: null, direction: null, commit: false });
  });
});
