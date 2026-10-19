// フリックできる指示カード（設計書 7.6）。判定は decideSwipe（純粋関数）に任せる
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";

/** 下地は、カードがどいた分（＋角丸の分）だけ見せる。半透明のカード越しに色が透けないように */
const UNDERLAY_OVERLAP = 24;
import { useQueryClient } from "@tanstack/react-query";
import {
  ACTION_COLORS,
  ACTION_LABELS,
  SWIPE_MAP,
  TESTIDS,
  UI_TEXT,
  type CeoAction,
  type InstructionSummary,
  type SwipeDirection,
  type SwipeOutcome,
} from "@baton/shared";
import { deliver, performTransition } from "../api/actions.ts";
import { decideSwipe, lockAxis, resistOffset, swipeThreshold, type Axis } from "../lib/decideSwipe.ts";
import { cardTitle, splitLimitError } from "../lib/text.ts";
import { relativeTime } from "../lib/time.ts";
import { haptic } from "../motion/haptics.ts";
import { collapseTween, easeOut, spring } from "../motion/tokens.ts";
import { useOutbox } from "../state/outbox.ts";
import { useUi } from "../state/ui.ts";
import { ActionIcon, IconClock } from "./Icons.tsx";

const LONG_PRESS_MS = 520;

/** 長押しメニュー・キーボードから、そのカードの操作を（抜けるアニメーション込みで）実行するための登録簿 */
const committers = new Map<string, (dir: SwipeDirection) => void>();
export function runCardAction(clientId: string, dir: SwipeDirection): void {
  committers.get(clientId)?.(dir);
}

export function outcomeLabel(outcome: Exclude<SwipeOutcome, null>): string {
  return outcome === "open_decision" ? UI_TEXT.sectionDecision : ACTION_LABELS[outcome];
}

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  axis: Axis | null;
  crossed: boolean;
  longPressFired: boolean;
  lastDx: number;
  lastDy: number;
  /** 速度を出すための直近の位置（pointer イベントの時刻つき） */
  samples: { t: number; x: number }[];
};

const VELOCITY_WINDOW_MS = 100;

/** 直近 100ms の指の動きから横の速度（px/s）を出す */
export function velocityFromSamples(samples: { t: number; x: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const recent = samples.filter((s) => last.t - s.t <= VELOCITY_WINDOW_MS);
  const first = recent.length >= 2 ? recent[0]! : samples[samples.length - 2]!;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return ((last.x - first.x) / dt) * 1000;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

type Props = {
  item: InstructionSummary;
  now: number;
  onOpen: (item: InstructionSummary) => void;
  /** 起動時の登場の遅れ（秒） */
  enterDelay?: number;
};

export function SwipeableCard({ item, now, onOpen, enterDelay = 0 }: Props) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(360);
  const gesture = useRef<Gesture | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const [flown, setFlown] = useState(false);
  const [crossedDir, setCrossedDir] = useState<SwipeDirection | null>(null);
  const [popKey, setPopKey] = useState(0);
  const outboxState = useOutbox((s) => s.items[item.clientId]?.state);
  const shakeAt = useUi((s) => s.shakes[item.clientId]);
  const isLocal = item.id === item.clientId && outboxState !== undefined;

  const map = SWIPE_MAP[item.status];
  const rightOutcome = isLocal ? null : map.right;
  const leftOutcome = isLocal ? null : map.left;

  // 下地の不透明度とアイコンの大きさ（横移動量に合わせて）
  const rightOpacity = useTransform(x, (v) => (v > 0 && rightOutcome ? Math.min(1, v / swipeThreshold(widthRef.current)) : 0));
  const leftOpacity = useTransform(x, (v) => (v < 0 && leftOutcome ? Math.min(1, -v / swipeThreshold(widthRef.current)) : 0));
  const rightScale = useTransform(rightOpacity, [0, 1], [0.6, 1]);
  const rightClip = useTransform(x, (v) => `inset(0 calc(100% - ${Math.max(0, v) + UNDERLAY_OVERLAP}px) 0 0 round var(--radius-lg))`);
  const leftClip = useTransform(x, (v) => `inset(0 0 0 calc(100% - ${Math.max(0, -v) + UNDERLAY_OVERLAP}px) round var(--radius-lg))`);
  const leftScale = useTransform(leftOpacity, [0, 1], [0.6, 1]);

  const [dir, setDir] = useState<"left" | "right" | null>(null);
  useMotionValueEvent(x, "change", (v) => {
    const d = v > 0.5 ? "right" : v < -0.5 ? "left" : null;
    if (d !== dir) setDir(d);
  });

  const measure = useCallback(() => {
    const w = cardRef.current?.getBoundingClientRect().width;
    if (w) widthRef.current = w;
  }, []);

  // 409 などで揺らす（左右に小さく 2 回）
  useEffect(() => {
    if (!shakeAt || Date.now() - shakeAt > 1500) return;
    setFlown(false);
    const run = async () => {
      if (Math.abs(x.get()) > 1) await animate(x, 0, spring.snappy);
      await animate(x, [0, -10, 10, -6, 6, 0], { duration: 0.42, ease: "easeInOut" });
    };
    void run();
  }, [shakeAt, x]);

  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  };

  const settleBack = useCallback(() => {
    void animate(x, 0, spring.snappy);
  }, [x]);

  const commit = useCallback(
    async (outcome: Exclude<SwipeOutcome, null>, direction: SwipeDirection) => {
      haptic();
      if (outcome === "open_decision") {
        // カードを元に戻してから判断シートを開く
        await animate(x, 0, spring.snappy);
        onOpen(item);
        return;
      }
      if (outcome === "send_back") {
        await animate(x, 0, spring.snappy);
        useUi.getState().setSendBackFor(item);
        return;
      }
      const sign = direction === "right" ? 1 : -1;
      measure();
      // 同じ方向へ画面外（幅 × 1.2。広い画面ではそれでは画面内に残るので、画面の端の外まで）へ 200ms で抜ける
      const rect = cardRef.current?.getBoundingClientRect();
      const toEdge = rect ? (sign > 0 ? window.innerWidth - rect.left + 24 : rect.right + 24) : 0;
      await animate(x, sign * Math.max(widthRef.current * 1.2, toEdge), { duration: reduce ? 0.12 : 0.2, ease: easeOut });
      setFlown(true);
      await nextFrame();
      await performTransition(qc, item, outcome as CeoAction);
    },
    [item, measure, onOpen, qc, reduce, x],
  );

  const runDirection = useCallback(
    (direction: SwipeDirection) => {
      const outcome = direction === "right" ? rightOutcome : leftOutcome;
      if (!outcome) {
        // 動けない方向は小さく揺れて戻る
        void animate(x, [0, direction === "right" ? 14 : -14, 0], { duration: 0.28 });
        return;
      }
      void commit(outcome, direction);
    },
    [commit, leftOutcome, rightOutcome, x],
  );

  useEffect(() => {
    committers.set(item.clientId, runDirection);
    return () => {
      if (committers.get(item.clientId) === runDirection) committers.delete(item.clientId);
    };
  }, [item.clientId, runDirection]);

  const openMenuAt = (clientX: number, clientY: number) => {
    if (isLocal) return;
    useUi.getState().setActionMenu({ instruction: item, x: clientX, y: clientY });
  };

  const endGesture = () => {
    const g = gesture.current;
    gesture.current = null;
    cancelLongPress();
    if (g?.axis === "x" && useUi.getState().draggingId === item.id) useUi.getState().setDragging(null);
    setCrossedDir(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const dragging = useUi.getState().draggingId;
    if (dragging && dragging !== item.id) return;
    measure();
    suppressClick.current = false;
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: null,
      crossed: false,
      longPressFired: false,
      lastDx: 0,
      lastDy: 0,
      samples: [{ t: e.timeStamp, x: 0 }],
    };
    cancelLongPress();
    const { clientX, clientY } = e;
    longPress.current = setTimeout(() => {
      const g = gesture.current;
      if (!g || g.axis !== null) return;
      g.longPressFired = true;
      suppressClick.current = true;
      haptic();
      openMenuAt(clientX, clientY);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId || g.longPressFired) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    g.lastDx = dx;
    g.lastDy = dy;
    g.samples.push({ t: e.timeStamp, x: dx });
    if (g.samples.length > 12) g.samples.shift();
    if (g.axis === null) {
      const axis = lockAxis(dx, dy);
      if (axis === null) return;
      cancelLongPress();
      if (axis === "y" || isLocal) {
        // 縦スクロールはブラウザに任せる
        gesture.current = null;
        return;
      }
      const dragging = useUi.getState().draggingId;
      if (dragging && dragging !== item.id) {
        gesture.current = null;
        return;
      }
      g.axis = "x";
      useUi.getState().setDragging(item.id);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 無視
      }
    }
    if (g.axis !== "x") return;
    suppressClick.current = true;
    const d = decideSwipe({ x: dx, y: dy }, { x: 0, y: 0 }, widthRef.current, item.status, "x");
    x.set(resistOffset(dx, d.allowed && !isLocal));
    if (d.pastThreshold !== g.crossed) {
      g.crossed = d.pastThreshold;
      if (d.pastThreshold) {
        // しきい値をまたいだ瞬間にアイコンが跳ねる・触覚
        haptic();
        setPopKey((k) => k + 1);
      }
      setCrossedDir(d.pastThreshold ? d.direction : null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) {
      endGesture();
      return;
    }
    if (g.axis === "x") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      // 離した位置が最後の move と同じなら、その時刻は速度に入れない（指は止まっていない。Motion のドラッグと同じ扱い）
      if (g.samples[g.samples.length - 1]?.x !== dx) g.samples.push({ t: e.timeStamp, x: dx });
      const vx = velocityFromSamples(g.samples);
      const d = decideSwipe({ x: dx, y: dy }, { x: vx, y: 0 }, widthRef.current, item.status, "x");
      endGesture();
      if (d.commit && d.outcome && d.direction) void commit(d.outcome, d.direction);
      else settleBack();
      return;
    }
    endGesture();
  };

  const onPointerCancel = () => {
    const wasX = gesture.current?.axis === "x";
    endGesture();
    if (wasX) settleBack();
  };

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (isLocal) return;
    onOpen(item);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (!isLocal) runDirection(e.key === "ArrowRight" ? "right" : "left");
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isLocal) onOpen(item);
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenuAt(r.left + r.width / 2, r.top + r.height / 2);
    }
  };

  const title = cardTitle(item);
  const progress = item.taskCounts.total > 0 ? item.taskCounts.done / item.taskCounts.total : 0;
  const failedSend = outboxState === "failed";
  const waiting = outboxState === "waiting" || (item.notBefore !== null && item.notBefore > now);
  const limit = item.status === "failed" && item.error ? splitLimitError(item.error) : null;

  const underlay = (side: "right" | "left", outcome: SwipeOutcome) => {
    const color = outcome ? `var(${ACTION_COLORS[outcome]})` : "transparent";
    const opacity = side === "right" ? rightOpacity : leftOpacity;
    const scale = side === "right" ? rightScale : leftScale;
    const clipPath = side === "right" ? rightClip : leftClip;
    const visible = dir === side && outcome !== null;
    return (
      <motion.div
        className={`underlay underlay--${side}`}
        data-testid={side === "right" ? TESTIDS.swipeUnderlayRight : TESTIDS.swipeUnderlayLeft}
        data-action={outcome ?? ""}
        aria-hidden="true"
        style={{ opacity, clipPath, "--underlay": color, visibility: visible ? "visible" : "hidden" } as unknown as CSSProperties}
      >
        {outcome && (
          <motion.span className="underlay__content" style={{ scale }}>
            <motion.span
              key={crossedDir === side ? popKey : "rest"}
              className="underlay__icon"
              initial={crossedDir === side ? { scale: 1.15 } : false}
              animate={{ scale: 1 }}
              transition={spring.pop}
            >
              <ActionIcon action={outcome} />
            </motion.span>
            <span className="underlay__label">{outcomeLabel(outcome)}</span>
          </motion.span>
        )}
      </motion.div>
    );
  };

  return (
    <motion.li
      className="card-slot"
      layout="position"
      layoutId={flown ? undefined : `card-${item.clientId}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: enterDelay } }}
      exit={flown ? { height: 0, marginBottom: 0, opacity: 0, transition: collapseTween } : { opacity: 0, transition: { duration: 0 } }}
      transition={spring.smooth}
      data-card=""
    >
      {underlay("right", rightOutcome)}
      {underlay("left", leftOutcome)}
      <motion.div
        ref={cardRef}
        className="card glass glass--card"
        style={{ x }}
        data-testid={TESTIDS.instructionCard}
        data-id={item.id}
        data-status={item.status}
        data-local={isLocal ? (outboxState ?? "") : undefined}
        data-failed-send={failedSend ? "true" : undefined}
        tabIndex={0}
        role="button"
        aria-label={title}
        aria-roledescription="card"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={(e) => {
          // タッチは最初に触れた子要素が暗黙に捕まえているので、カード自身が手放したときだけ扱う
          if (e.target === e.currentTarget && gesture.current?.axis === "x" && gesture.current.pointerId === e.pointerId) onPointerCancel();
        }}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          cancelLongPress();
          suppressClick.current = true;
          openMenuAt(e.clientX, e.clientY);
        }}
      >
        <ReviewSweep clientId={item.clientId} status={item.status} />
        <div className="card__row">
          <span className={`status-dot status-dot--${item.status}`} aria-hidden="true" />
          <div className="card__main">
            <div className="card__title">{title}</div>
            {(item.projectName || waiting) && (
              <div className="card__meta">
                {waiting && (
                  <span className="card__clock" title={item.notBefore ? new Date(item.notBefore).toLocaleString() : undefined}>
                    <IconClock size={13} />
                  </span>
                )}
                {item.projectName && <span className="card__project">{item.projectName}</span>}
              </div>
            )}
            {limit && (
              <div className="card__error">
                {limit.limit && <span className="card__error-prefix">{UI_TEXT.limitReached}</span>}
                <span className="card__error-text">{limit.rest}</span>
              </div>
            )}
          </div>
          <span className="card__time">{relativeTime(item.statusChangedAt, now)}</span>
        </div>
        {item.taskCounts.total > 0 && (
          <div className="progress" aria-hidden="true">
            <motion.div className="progress__bar" initial={false} animate={{ scaleX: progress }} transition={spring.smooth} />
          </div>
        )}
        {failedSend && (
          <div className="card__resend">
            <span className="card__resend-text">{UI_TEXT.sendFailed}</span>
            <button
              type="button"
              className="chip-button chip-button--danger"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void deliver(qc, item.clientId);
              }}
            >
              {UI_TEXT.resend}
            </button>
          </div>
        )}
      </motion.div>
    </motion.li>
  );
}

/** review に来たときにふちの光が 1 回走る（600ms）。まとまりを移るとカードは作り直されるので、前の状態は外に覚えておく */
const lastSeenStatus = new Map<string, InstructionSummary["status"]>();

function ReviewSweep({ clientId, status }: { clientId: string; status: InstructionSummary["status"] }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const prev = lastSeenStatus.get(clientId);
    if (status === "review" && prev !== undefined && prev !== "review") setN((v) => v + 1);
    lastSeenStatus.set(clientId, status);
  }, [clientId, status]);
  if (n === 0) return null;
  return <span key={n} className="card__sweep" aria-hidden="true" />;
}
