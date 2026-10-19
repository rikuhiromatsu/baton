// 指示カードの列（13.4・13.8）。≥1024px は右の列（折りたためる）、<1024px は上部バーの `指示` で開くシート
import { useCallback } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "@tanstack/react-router";
import { TESTIDS, UI_TEXT_V2, displayGroup, type InstructionSummary } from "@baton/shared";
import { useActiveList } from "../api/queries.ts";
import { useNow } from "../lib/useNow.ts";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";
import { IconCards, IconChevronRight } from "./Icons.tsx";
import { InstructionList } from "./InstructionList.tsx";
import { Sheet } from "./Sheet.tsx";
import { SkeletonCards } from "./SkeletonScreen.tsx";

/** 判断待ち・確認の数（バッジ） */
export function useCardsBadge(): number {
  const list = useActiveList();
  return (list.data?.items ?? []).filter((i) => {
    const g = displayGroup(i);
    return g === "needs_decision" || g === "review";
  }).length;
}

function useOpenCard(after?: () => void) {
  const navigate = useNavigate();
  return useCallback(
    (item: InstructionSummary) => {
      after?.();
      void navigate({ to: "/i/$id", params: { id: item.id } });
    },
    [after, navigate],
  );
}

function CardsBody({ projectId, onOpen }: { projectId: string | null; onOpen: (i: InstructionSummary) => void }) {
  const list = useActiveList();
  const now = useNow();
  if (!list.data) return <SkeletonCards count={3} />;
  return <InstructionList items={list.data.items} now={now} onOpen={onOpen} projectId={projectId} />;
}

export function CardsColumn({ projectId }: { projectId: string | null }) {
  const collapsed = useUi((s) => s.cardsCollapsed);
  const onOpen = useOpenCard();
  const badge = useCardsBadge();
  return (
    <aside className="cards-col" data-collapsed={collapsed ? "true" : "false"}>
      <div className="cards-col__head">
        <button
          type="button"
          className="cards-col__toggle"
          aria-expanded={!collapsed}
          aria-label={UI_TEXT_V2.instruction.cards}
          onClick={() => useUi.getState().setCardsCollapsed(!collapsed)}
        >
          <IconCards size={17} />
          {!collapsed && <span className="cards-col__title">{UI_TEXT_V2.instruction.cards}</span>}
          {badge > 0 && <span className="badge badge--soft">{badge}</span>}
          {!collapsed && (
            <motion.span className="cards-col__chev" animate={{ rotate: 0 }}>
              <IconChevronRight size={15} />
            </motion.span>
          )}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            className="cards-col__body"
            data-testid={TESTIDS.cardsPanel}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.16 } }}
            transition={spring.smooth}
          >
            <CardsBody projectId={projectId} onOpen={onOpen} />
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}

export function CardsButton() {
  const badge = useCardsBadge();
  return (
    <button type="button" className="header-button" data-testid={TESTIDS.cardsButton} aria-label={UI_TEXT_V2.instruction.cards} onClick={() => useUi.getState().setCardsSheetOpen(true)}>
      <IconCards size={19} />
      <span className="header-button__label">{UI_TEXT_V2.instruction.cards}</span>
      <AnimatePresence>
        {badge > 0 && (
          <motion.span key={badge} className="badge badge--float" initial={{ scale: 0.4 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring.pop}>
            {badge}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

export function CardsSheet({ projectId }: { projectId: string | null }) {
  const open = useUi((s) => s.cardsSheetOpen);
  const close = useCallback(() => useUi.getState().setCardsSheetOpen(false), []);
  const onOpen = useOpenCard(close);
  return (
    <Sheet open={open} onClose={close} label={UI_TEXT_V2.instruction.cards} title={UI_TEXT_V2.instruction.cards} size="tall" className="cards-sheet">
      <div data-testid={TESTIDS.cardsPanel} className="cards-sheet__body">
        <CardsBody projectId={projectId} onOpen={onOpen} />
      </div>
    </Sheet>
  );
}
