// F4 フリック判定の純粋関数（decideSwipe）: しきい値・速度・方向ロック・動けない方向。v2 は開いた判断のある running は判断待ち（13.8）
import { describe, expect, it } from "vitest";
import type { CardLike, InstructionStatus } from "@baton/shared";
import { SWIPE, decideSwipe, lockAxis, resistOffset, swipeThreshold } from "../../src/web/lib/decideSwipe.ts";

const card = (status: InstructionStatus, openDecisionCount = 0): CardLike => ({ status, openDecisionCount });
const W = 360;
const still = { x: 0, y: 0 };

describe("F4 decideSwipe", () => {
  it("しきい値は min(120, 幅 × 0.32)", () => {
    expect(swipeThreshold(360)).toBeCloseTo(115.2);
    expect(swipeThreshold(800)).toBe(120);
    expect(swipeThreshold(-1)).toBe(0);
  });

  it("10px 動くまでは向きを決めず、|dx| > |dy| × 1.5 なら横", () => {
    expect(lockAxis(5, 5)).toBeNull();
    expect(lockAxis(20, 5)).toBe("x");
    expect(lockAxis(12, 10)).toBe("y");
  });

  it("確認（review）: 右で承認、左で差し戻し。しきい値を越えたら確定", () => {
    expect(decideSwipe({ x: 130, y: 0 }, still, W, card("review")).outcome).toBe("approve");
    expect(decideSwipe({ x: 130, y: 0 }, still, W, card("review")).commit).toBe(true);
    expect(decideSwipe({ x: -130, y: 0 }, still, W, card("review")).outcome).toBe("send_back");
    expect(decideSwipe({ x: 60, y: 0 }, still, W, card("review")).commit).toBe(false);
  });

  it("速いフリックは距離が短くても確定（40px 以上）。逆向きに速く戻すと確定しない", () => {
    expect(decideSwipe({ x: 50, y: 0 }, { x: SWIPE.flickVelocity + 1, y: 0 }, W, card("review")).commit).toBe(true);
    expect(decideSwipe({ x: 30, y: 0 }, { x: 2000, y: 0 }, W, card("review")).commit).toBe(false);
    expect(decideSwipe({ x: 140, y: 0 }, { x: -1200, y: 0 }, W, card("review")).commit).toBe(false);
  });

  it("動けない方向は確定しない（running の右）", () => {
    const d = decideSwipe({ x: 200, y: 0 }, still, W, card("running"));
    expect(d.allowed).toBe(false);
    expect(d.commit).toBe(false);
    expect(resistOffset(100, false)).toBeCloseTo(100 * SWIPE.blockedElastic);
  });

  it("開いた判断（承認）のある running は判断待ちのまとまり: 右は判断シートを開くだけ、左は取消", () => {
    const right = decideSwipe({ x: 200, y: 0 }, still, W, card("running", 1));
    expect(right.outcome).toBe("open_decision");
    expect(right.commit).toBe(true);
    expect(decideSwipe({ x: -200, y: 0 }, still, W, card("running", 1)).outcome).toBe("cancel");
  });

  it("縦の動きはフリックにしない", () => {
    const d = decideSwipe({ x: 12, y: 60 }, still, W, card("review"));
    expect(d.axis).toBe("y");
    expect(d.commit).toBe(false);
  });
});
