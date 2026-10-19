// 指示詳細シート（7.2・7.5・7.7）。ホームの上に下からせり上がる。カードからの共有要素遷移
import { useEffect, useRef, useState } from "react";
import { animate, motion, useDragControls, useMotionValue, useTransform } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ACTION_COLORS,
  STATUS_LABELS,
  SWIPE_MAP,
  TESTIDS,
  UI_TEXT,
  type CeoAction,
  type InstructionSummary,
  type SwipeDirection,
} from "@baton/shared";
import { performTransition } from "../api/actions.ts";
import { findInstruction } from "../api/cache.ts";
import { useInstructionDetail } from "../api/queries.ts";
import { getRealtime } from "../api/ws.ts";
import { ArtifactList } from "../components/ArtifactList.tsx";
import { DecisionPanel } from "../components/DecisionPanel.tsx";
import { EventLog } from "../components/EventLog.tsx";
import { ActionIcon, IconX } from "../components/Icons.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { outcomeLabel } from "../components/SwipeableCard.tsx";
import { TaskTree } from "../components/TaskTree.tsx";
import { cardTitle, splitLimitError } from "../lib/text.ts";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";

const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 600;

type Props = { id: string; onClose: () => void };

export function InstructionSheet({ id, onClose }: Props) {
  const qc = useQueryClient();
  const detail = useInstructionDetail(id);
  const summary: InstructionSummary | undefined = detail.data?.instruction ?? findInstruction(qc, id);
  // 開いた時点の clientId で共有要素遷移する（後から変わっても付け替えない）
  const [layoutKey] = useState(() => findInstruction(qc, id)?.clientId ?? null);
  const [settled, setSettled] = useState(false);
  const y = useMotionValue(0);
  const scrimOpacity = useTransform(y, [0, 400], [1, 0.2]);
  const drag = useDragControls();
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開いている間はその指示のログを購読する
  useEffect(() => {
    getRealtime()?.subscribe(id);
    return () => getRealtime()?.subscribe(null);
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUi.getState().sendBackFor && !useUi.getState().actionMenu) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = detail.data;
  const status = summary?.status;
  const openDecision = d?.decisions.find((x) => x.status === "open") ?? null;
  const limit = d?.instruction.error ? splitLimitError(d.instruction.error) : null;

  const actions: { dir: SwipeDirection; action: CeoAction }[] = [];
  if (summary && status) {
    const map = SWIPE_MAP[status];
    if (map.left && map.left !== "open_decision") actions.push({ dir: "left", action: map.left });
    if (map.right && map.right !== "open_decision") actions.push({ dir: "right", action: map.right });
  }

  const runAction = async (action: CeoAction) => {
    if (!summary) return;
    if (action === "send_back") {
      useUi.getState().setSendBackFor(summary);
      return;
    }
    await performTransition(qc, summary, action);
  };

  return (
    <motion.div className="sheet-layer" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 1, transition: { duration: 0.24 } }}>
      <motion.div
        className="sheet-scrim"
        style={{ opacity: scrimOpacity }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.2 } }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        className="sheet glass glass--sheet"
        data-testid={TESTIDS.instructionSheet}
        data-settled={settled ? "true" : "false"}
        role="dialog"
        aria-modal="true"
        aria-label={summary ? cardTitle(summary) : undefined}
        layoutId={layoutKey ? `card-${layoutKey}` : undefined}
        initial={layoutKey ? { opacity: 1 } : { y: "100%" }}
        animate={{ y: 0, opacity: 1 }}
        exit={layoutKey ? { opacity: 1 } : { y: "100%", transition: { duration: 0.24 } }}
        transition={spring.smooth}
        style={{ y }}
        drag="y"
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.9 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > CLOSE_DISTANCE || info.velocity.y > CLOSE_VELOCITY) onClose();
          else void animate(y, 0, spring.snappy);
        }}
        onLayoutAnimationComplete={() => setSettled(true)}
        onAnimationComplete={() => setSettled(true)}
      >
        <motion.div className="sheet__grab" onPointerDown={(e) => drag.start(e)} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
          <span className="sheet__handle" aria-hidden="true" />
          <div className="sheet__toolbar">
            {status && (
              <span className={`status-chip status-chip--${status}`}>
                <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
                <span>{STATUS_LABELS[status]}</span>
              </span>
            )}
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              data-testid={TESTIDS.sheetClose}
              aria-label={UI_TEXT.close}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
            >
              <IconX size={18} />
            </button>
          </div>
        </motion.div>
        <motion.div
          className="sheet__scroll"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2, delay: layoutKey ? 0.12 : 0 } }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
        >
          {summary ? (
            <header className="sheet__header">
              <h2 className="sheet__title">{cardTitle(summary)}</h2>
              {summary.projectName && <div className="sheet__project">{summary.projectName}</div>}
              {summary.title && summary.body.trim() !== summary.title.trim() && <p className="sheet__body">{summary.body}</p>}
              {d?.instruction.feedback && <p className="sheet__feedback">{d.instruction.feedback}</p>}
              {limit && (
                <p className="sheet__error">
                  {limit.limit && <span className="card__error-prefix">{UI_TEXT.limitReached}</span>}
                  <span>{limit.rest}</span>
                </p>
              )}
            </header>
          ) : null}

          {!d ? (
            <SkeletonScreen variant="detail" />
          ) : (
            <div className="sheet__sections">
              {openDecision && <DecisionPanel decision={openDecision} />}

              {d.instruction.resultSummary && (
                <section className="section">
                  <h3 className="section__label">{UI_TEXT.sectionReport}</h3>
                  <p className="report" data-testid={TESTIDS.reportText}>
                    {d.instruction.resultSummary}
                  </p>
                </section>
              )}

              {actions.length > 0 && (
                <div className="sheet__actions">
                  {actions.map((a) => (
                    <motion.button
                      key={a.action}
                      type="button"
                      className="action-button"
                      style={{ color: `var(${ACTION_COLORS[a.action]})` }}
                      whileTap={{ scale: 0.96 }}
                      transition={spring.snappy}
                      onClick={() => void runAction(a.action)}
                    >
                      <ActionIcon action={a.action} size={18} />
                      <span>{outcomeLabel(a.action)}</span>
                    </motion.button>
                  ))}
                </div>
              )}

              {d.tasks.length > 0 && (
                <section className="section">
                  <h3 className="section__label">{UI_TEXT.sectionTasks}</h3>
                  <TaskTree tasks={d.tasks} agents={d.project?.agents ?? []} />
                </section>
              )}

              {d.artifacts.length > 0 && (
                <section className="section">
                  <h3 className="section__label">{UI_TEXT.sectionArtifacts}</h3>
                  <ArtifactList artifacts={d.artifacts} />
                </section>
              )}

              <section className="section">
                <EventLog instructionId={id} />
              </section>
            </div>
          )}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
