// まとまりごとの一覧（7.3・7.5）。AnimatePresence と layout で並べ替えを動かす
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { STATUS_LABELS, TESTIDS, type InstructionSummary } from "@baton/shared";
import { groupForHome, sortArchived } from "../lib/sort.ts";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";
import { SwipeableCard } from "./SwipeableCard.tsx";

type Props = {
  items: readonly InstructionSummary[];
  now: number;
  onOpen: (item: InstructionSummary) => void;
};

export function InstructionList({ items, now, onOpen }: Props) {
  const groups = groupForHome(items, now);
  const revealed = useUi((s) => s.listRevealed);
  useEffect(() => {
    if (!revealed) {
      const t = setTimeout(() => useUi.getState().setListRevealed(), 400);
      return () => clearTimeout(t);
    }
  }, [revealed]);
  let index = 0;
  return (
    <div className="list" data-testid={TESTIDS.instructionList}>
      <AnimatePresence initial={false}>
        {groups.map((g) => (
          <motion.section
            key={g.status}
            className="group"
            data-testid={TESTIDS.instructionGroup(g.status)}
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={spring.smooth}
          >
            <h2 className="group__label">
              <span>{STATUS_LABELS[g.status]}</span>
              <span className="group__count">{g.items.length}</span>
            </h2>
            <ul className="group__items">
              <AnimatePresence initial={!revealed}>
                {g.items.map((item) => {
                  const delay = revealed ? 0 : Math.min(index++, 12) * 0.03;
                  return <SwipeableCard key={item.clientId} item={item} now={now} onOpen={onOpen} enterDelay={delay} />;
                })}
              </AnimatePresence>
            </ul>
          </motion.section>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function ArchiveList({ items, now, onOpen }: Props) {
  const sorted = sortArchived(items);
  return (
    <ul className="group__items archive-list" data-testid={TESTIDS.archiveList}>
      <AnimatePresence initial={false}>
        {sorted.map((item, i) => (
          <SwipeableCard key={item.clientId} item={item} now={now} onOpen={onOpen} enterDelay={Math.min(i, 12) * 0.03} />
        ))}
      </AnimatePresence>
    </ul>
  );
}
