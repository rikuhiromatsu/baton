// 長押し・右クリックの操作メニュー（フリックできない人のため。7.6）
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ACTION_COLORS, SWIPE_MAP, type SwipeDirection } from "@baton/shared";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";
import { ActionIcon } from "./Icons.tsx";
import { outcomeLabel, runCardAction } from "./SwipeableCard.tsx";

export function ActionMenu() {
  const menu = useUi((s) => s.actionMenu);
  const close = () => useUi.getState().setActionMenu(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    // 長押しを離したときの pointerup で閉じないよう、次のフレームから
    const id = requestAnimationFrame(() => document.addEventListener("pointerdown", onDown));
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menu]);

  const options: { dir: SwipeDirection; outcome: NonNullable<(typeof SWIPE_MAP)["queued"]["right"]> }[] = [];
  if (menu) {
    const map = SWIPE_MAP[menu.instruction.status];
    if (map.right) options.push({ dir: "right", outcome: map.right });
    if (map.left) options.push({ dir: "left", outcome: map.left });
  }
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  const left = menu ? Math.min(Math.max(12, menu.x - 100), vw - 212) : 0;
  const top = menu ? Math.min(Math.max(12, menu.y + 8), vh - 24 - options.length * 48) : 0;

  return (
    <AnimatePresence>
      {menu && options.length > 0 && (
        <motion.div
          ref={ref}
          role="menu"
          className="menu action-menu glass glass--sheet"
          style={{ left, top }}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.16 } }}
          transition={spring.snappy}
        >
          {options.map((o) => (
            <button
              key={o.dir}
              type="button"
              role="menuitem"
              className="menu__item"
              style={{ color: `var(${ACTION_COLORS[o.outcome]})` }}
              onClick={() => {
                const id = menu.instruction.clientId;
                close();
                runCardAction(id, o.dir);
              }}
            >
              <ActionIcon action={o.outcome} size={18} />
              <span className="menu__label">{outcomeLabel(o.outcome)}</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
