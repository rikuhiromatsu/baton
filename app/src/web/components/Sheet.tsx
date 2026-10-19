// 下からせり上がるシート（モバイル）・中央に浮くシート（デスクトップ）の共通部品。下へドラッグか Escape で閉じる
import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useTransform } from "motion/react";
import { UI_TEXT } from "@baton/shared";
import { spring } from "../motion/tokens.ts";
import { IconX } from "./Icons.tsx";

type Props = {
  open: boolean;
  onClose: () => void;
  testId?: string;
  label?: string;
  title?: ReactNode;
  children: ReactNode;
  /** 大きいシート（指示のカード・設定の一覧） */
  size?: "auto" | "tall";
  className?: string;
};

export function Sheet({ open, onClose, testId, label, title, children, size = "auto", className = "" }: Props) {
  const y = useMotionValue(0);
  const scrim = useTransform(y, [0, 360], [1, 0.1]);
  const drag = useDragControls();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    y.set(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    const t = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(t);
      window.removeEventListener("keydown", onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, onClose, y]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className={`sheet-modal sheet-modal--${size}`} initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 1, transition: { duration: 0.24 } }}>
          <motion.div className="sheet-modal__scrim" style={{ opacity: scrim }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={ref}
            tabIndex={-1}
            className={`sheet-modal__panel glass glass--sheet ${className}`.trim()}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            data-testid={testId}
            style={{ y }}
            initial={{ y: "100%", opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%", opacity: 0.6, transition: { duration: 0.24, ease: [0.65, 0, 0.35, 1] } }}
            transition={spring.smooth}
            drag="y"
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.9 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
              else void animate(y, 0, spring.snappy);
            }}
          >
            <div className="sheet-modal__grab" onPointerDown={(e) => drag.start(e)}>
              <span className="sheet__handle" aria-hidden="true" />
              <div className="sheet-modal__head">
                <div className="sheet-modal__title">{title}</div>
                <button type="button" className="icon-button" aria-label={UI_TEXT.close} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
                  <IconX size={18} />
                </button>
              </div>
            </div>
            <div className="sheet-modal__body">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
