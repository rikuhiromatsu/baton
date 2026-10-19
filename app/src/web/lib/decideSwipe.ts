// フリックの判定（設計書 7.6・D-24）。画面から切り離した純粋関数にして、F4 で検査する。
import { SWIPE_MAP, type InstructionStatus, type SwipeDirection, type SwipeOutcome } from "@baton/shared";

export const SWIPE = {
  /** 向きを決めるまでに指が動く距離 */
  lockDistance: 10,
  /** |dx| > |dy| × この値なら横（フリック） */
  lockRatio: 1.5,
  /** 確定に必要な距離の上限 */
  maxThreshold: 120,
  /** 確定に必要な距離（カード幅に対する比） */
  widthRatio: 0.32,
  /** 速いフリックとみなす速度（px/s） */
  flickVelocity: 800,
  /** 速いフリックでも最低限必要な距離 */
  flickMinDistance: 40,
  /** その方向に動けないときの重さ */
  blockedElastic: 0.12,
} as const;

export type Axis = "x" | "y";
export type Vec = { x: number; y: number };

export type SwipeDecision = {
  /** 向きの判定。null はまだ決まっていない（10px 未満） */
  axis: Axis | null;
  direction: SwipeDirection | null;
  /** その方向の操作（SWIPE_MAP）。動けない方向は null */
  outcome: SwipeOutcome;
  /** その方向に動けるか */
  allowed: boolean;
  /** 確定に必要な距離 */
  threshold: number;
  /** 距離がしきい値を超えているか（下地の跳ねに使う） */
  pastThreshold: boolean;
  /** 指を離したときに確定するか */
  commit: boolean;
};

/** 指の動きから向きを決める。10px 動くまでは null */
export function lockAxis(dx: number, dy: number): Axis | null {
  if (Math.hypot(dx, dy) < SWIPE.lockDistance) return null;
  return Math.abs(dx) > Math.abs(dy) * SWIPE.lockRatio ? "x" : "y";
}

/** 確定のしきい値: min(120px, 幅 × 0.32) */
export function swipeThreshold(width: number): number {
  return Math.min(SWIPE.maxThreshold, Math.max(0, width) * SWIPE.widthRatio);
}

/** 動けない方向は重くする（指に付いてくる量を 0.12 倍） */
export function resistOffset(dx: number, allowed: boolean): number {
  return allowed ? dx : dx * SWIPE.blockedElastic;
}

/**
 * 今の移動量と速度から、フリックの向き・操作・確定を決める。
 * axis を渡すと（ドラッグ開始時に決めた向き）、それを優先する。
 */
export function decideSwipe(
  offset: Vec,
  velocity: Vec,
  width: number,
  status: InstructionStatus,
  axis?: Axis | null,
): SwipeDecision {
  const threshold = swipeThreshold(width);
  const lockedAxis = axis === undefined ? lockAxis(offset.x, offset.y) : axis;
  if (lockedAxis !== "x" || offset.x === 0) {
    return { axis: lockedAxis, direction: null, outcome: null, allowed: false, threshold, pastThreshold: false, commit: false };
  }
  const direction: SwipeDirection = offset.x > 0 ? "right" : "left";
  const outcome = SWIPE_MAP[status][direction];
  const allowed = outcome !== null;
  const distance = Math.abs(offset.x);
  const sign = Math.sign(offset.x);
  const pastThreshold = distance >= threshold;
  const fastSameWay = Math.abs(velocity.x) >= SWIPE.flickVelocity && Math.sign(velocity.x) === sign;
  // しきい値を超えていても、逆向きに速く戻している（やめようとしている）ときは確定しない
  const fastBack = Math.abs(velocity.x) >= SWIPE.flickVelocity && Math.sign(velocity.x) === -sign;
  const flick = fastSameWay && distance >= SWIPE.flickMinDistance;
  const commit = allowed && !fastBack && (pastThreshold || flick);
  return { axis: "x", direction, outcome, allowed, threshold, pastThreshold: allowed && pastThreshold, commit };
}
