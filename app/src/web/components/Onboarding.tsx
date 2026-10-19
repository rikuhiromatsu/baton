// 初回の案内（D-38）。最初のログイン時に 1 回だけ出し、メニューの「使い方」からいつでも開ける
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ONBOARDING_STEPS, TESTIDS, UI_TEXT } from "@baton/shared";
import { spring } from "../motion/tokens.ts";
import { prefixed } from "../state/storage.ts";
import { useUi } from "../state/ui.ts";
import { IconArrowUp, IconCheck, IconSendBack } from "./Icons.tsx";

/** 見終わった印（localStorage）。E2E はこれを先に入れて案内を出さない */
export const ONBOARDED_KEY = "baton:onboarded";

function hasSeen(): boolean {
  try {
    return localStorage.getItem(prefixed(ONBOARDED_KEY)) === "1";
  } catch {
    return true; // 保存できない環境では毎回出さない
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(prefixed(ONBOARDED_KEY), "1");
  } catch {
    // 無視
  }
}

/** ログイン済みになったら、初回だけ自動で開く */
export function useAutoOnboarding(loggedIn: boolean): void {
  useEffect(() => {
    if (loggedIn && !hasSeen()) useUi.getState().setOnboardingOpen(true);
  }, [loggedIn]);
}

export function Onboarding() {
  const open = useUi((s) => s.onboardingOpen);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const last = step === ONBOARDING_STEPS.length - 1;
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // 開いたらフォーカスを案内の中へ、閉じたら元の場所へ戻す（裏の画面は AppShell が inert にする）
  useEffect(() => {
    if (!open) return;
    setStep(0);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(t);
      returnFocus.current?.focus({ preventScroll: true });
    };
  }, [open]);

  const close = () => {
    markSeen();
    useUi.getState().setOnboardingOpen(false);
  };
  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setStep(to);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" && !last) go(step + 1);
      else if (e.key === "ArrowLeft" && step > 0) go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const current = ONBOARDING_STEPS[step]!;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="onboarding-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.16 } }}
        >
          <motion.section
            className="onboarding glass glass--sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-title"
            data-testid={TESTIDS.onboarding}
            data-step={step}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={spring.smooth}
          >
            <button type="button" className="onboarding__skip" data-testid={TESTIDS.onboardingSkip} onClick={close}>
              {UI_TEXT.onboardingSkip}
            </button>
            <div className="onboarding__stage">
              <AnimatePresence mode="wait" custom={dir} initial={false}>
                <motion.div
                  key={step}
                  className="onboarding__page"
                  custom={dir}
                  initial={{ opacity: 0, x: dir * 32 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: dir * -32 }}
                  transition={spring.smooth}
                >
                  <Illustration step={step} />
                  <h2 id="onboarding-title" className="onboarding__title">
                    {current.title}
                  </h2>
                  <p className="onboarding__body">{current.body}</p>
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="onboarding__dots" aria-hidden="true">
              {ONBOARDING_STEPS.map((_, i) => (
                <motion.span
                  key={i}
                  className="onboarding__dot"
                  animate={{ width: i === step ? 20 : 6, opacity: i === step ? 1 : 0.35 }}
                  transition={spring.snappy}
                />
              ))}
            </div>
            <div className="onboarding__actions">
              {step > 0 ? (
                <button type="button" className="onboarding__btn" data-testid={TESTIDS.onboardingBack} onClick={() => go(step - 1)}>
                  {UI_TEXT.onboardingBack}
                </button>
              ) : (
                <span />
              )}
              <motion.button
                type="button"
                ref={primaryRef}
                className="onboarding__btn onboarding__btn--primary"
                data-testid={TESTIDS.onboardingNext}
                whileTap={{ scale: 0.95 }}
                transition={spring.pop}
                onClick={() => (last ? close() : go(step + 1))}
              >
                {last ? UI_TEXT.onboardingStart : UI_TEXT.onboardingNext}
              </motion.button>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 各ステップの小さな図。文字は使わず、動きで操作を見せる */
function Illustration({ step }: { step: number }) {
  const reduce = useReducedMotion();
  const loop = (values: number[], duration = 2.4) =>
    reduce ? {} : { animate: { x: values }, transition: { duration, repeat: Infinity, ease: "easeInOut" as const, repeatDelay: 0.6 } };

  if (step === 0) {
    return (
      <div className="ob-illu" aria-hidden="true">
        <div className="ob-composer glass glass--bar">
          <motion.span className="ob-line" style={{ width: "62%" }} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
          <span className="ob-send">
            <IconArrowUp size={14} />
          </span>
        </div>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div className="ob-illu ob-tree" aria-hidden="true">
        {["CEO", "COO", "Leader", "Members"].map((label, i) => (
          <motion.div
            key={label}
            className={`ob-node ob-node--${i}`}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.gentle, delay: i * 0.18 }}
          >
            {i === 3 ? (
              <span className="ob-members">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <i />
            )}
          </motion.div>
        ))}
      </div>
    );
  }
  if (step === 2) {
    return (
      <div className="ob-illu" aria-hidden="true">
        <motion.div className="ob-card glass glass--card ob-card--review" initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring.gentle}>
          <span className="ob-dot ob-dot--review" />
          <span className="ob-line" style={{ width: "58%" }} />
        </motion.div>
      </div>
    );
  }
  if (step === 3) {
    return (
      <div className="ob-illu" aria-hidden="true">
        <div className="ob-swipe">
          <span className="ob-under ob-under--right">
            <IconCheck size={14} />
          </span>
          <span className="ob-under ob-under--left">
            <IconSendBack size={14} />
          </span>
          <motion.div className="ob-card glass glass--card" {...loop([0, 64, 0, -64, 0], 3.2)}>
            <span className="ob-dot ob-dot--review" />
            <span className="ob-line" style={{ width: "52%" }} />
          </motion.div>
        </div>
      </div>
    );
  }
  return (
    <div className="ob-illu" aria-hidden="true">
      <div className="ob-topbar glass glass--chip">
        <span className="ob-dot ob-dot--online" />
        <motion.span className="ob-avatar" animate={reduce ? {} : { scale: [1, 1.12, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
      </div>
    </div>
  );
}
