// 差し戻しのコメント入力（3.5・7.5）。送ると queued に戻る（取り消しトーストは出さない）
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT } from "@baton/shared";
import { performTransition } from "../api/actions.ts";
import { cardTitle } from "../lib/text.ts";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";
import { IconX } from "./Icons.tsx";

export function SendBackSheet() {
  const target = useUi((s) => s.sendBackFor);
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const close = () => useUi.getState().setSendBackFor(null);

  useEffect(() => {
    if (!target) return;
    setComment("");
    setBusy(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    const res = await performTransition(qc, target, "send_back", comment.trim() || undefined);
    setBusy(false);
    if (res.ok) close();
  };

  return (
    <AnimatePresence>
      {target && (
        <motion.div className="modal" key="sendback" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.16 } }}>
          <div className="modal__scrim" onClick={close} />
          <motion.div
            className="mini-sheet glass glass--sheet"
            role="dialog"
            aria-modal="true"
            aria-label={cardTitle(target)}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0, transition: { duration: 0.16 } }}
            transition={spring.smooth}
            onAnimationComplete={() => inputRef.current?.focus({ preventScroll: true })}
          >
            <div className="mini-sheet__head">
              <span className="mini-sheet__title">{cardTitle(target)}</span>
              <button type="button" className="icon-button" aria-label={UI_TEXT.close} onClick={close}>
                <IconX size={18} />
              </button>
            </div>
            <textarea
              ref={inputRef}
              className="field"
              rows={4}
              data-testid={TESTIDS.sendbackInput}
              aria-label={UI_TEXT.commentAria}
              value={comment}
              maxLength={2000}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button type="button" className="primary-button primary-button--warning" data-testid={TESTIDS.sendbackSubmit} disabled={busy} onClick={() => void submit()}>
              {UI_TEXT.sendBackSubmit}
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
