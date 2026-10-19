// spring と時間の値（設計書 7.7）
import type { Transition } from "motion/react";

export const spring = {
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 1 },
  smooth: { type: "spring", stiffness: 320, damping: 32, mass: 1 },
  gentle: { type: "spring", stiffness: 180, damping: 24, mass: 1 },
  pop: { type: "spring", stiffness: 700, damping: 18, mass: 0.6 },
} as const satisfies Record<string, Transition>;

export const easeOut = [0.22, 1, 0.36, 1] as const;
export const easeInOut = [0.65, 0, 0.35, 1] as const;

export const duration = {
  fade: 0.16,
  exit: 0.2,
  collapse: 0.24,
  skeletonOut: 0.22,
  reducedFade: 0.12,
} as const;

export const fade: Transition = { duration: duration.fade, ease: easeOut };
export const exitTween: Transition = { duration: duration.exit, ease: easeOut };
export const collapseTween: Transition = { duration: duration.collapse, ease: easeInOut };
