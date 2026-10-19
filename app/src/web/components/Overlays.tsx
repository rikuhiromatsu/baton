// 画面の上に重ねる小物: 長押しの操作メニュー・発言のメニュー・差し戻しシート・トースト（v1 7.5・7.6、DESIGN-v2 4.8・13.4）
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ACTION_COLORS, ACTION_LABELS, TESTIDS, UI_TEXT, UI_TEXT_V2, swipeActionFor, type SwipeDirection, type SwipeOutcome } from "@baton/shared";
import { performTransition, performUndo } from "../api/actions.ts";
import { deliver } from "../api/messages.ts";
import { cardTitle } from "../lib/text.ts";
import { spring } from "../motion/tokens.ts";
import { useToasts, type Toast } from "../state/toasts.ts";
import { useUi } from "../state/ui.ts";
import { ActionIcon, IconCopy, IconEye, IconX } from "./Icons.tsx";
import { outcomeLabel, runCardAction } from "./SwipeableCard.tsx";

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
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
  }, [open, close, ref]);
}

function placeMenu(x: number, y: number, rows: number): { left: number; top: number } {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  return { left: Math.min(Math.max(12, x - 100), vw - 212), top: Math.min(Math.max(12, y + 8), vh - 24 - rows * 48) };
}

/** カードの長押し・右クリックの操作メニュー（フリックできない人のため。7.6） */
export function ActionMenu() {
  const menu = useUi((s) => s.actionMenu);
  const close = () => useUi.getState().setActionMenu(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(menu !== null, close, ref);
  const options: { dir: SwipeDirection; outcome: Exclude<SwipeOutcome, null> }[] = [];
  if (menu) {
    const r = swipeActionFor(menu.instruction, "right");
    const l = swipeActionFor(menu.instruction, "left");
    if (r) options.push({ dir: "right", outcome: r });
    if (l) options.push({ dir: "left", outcome: l });
  }
  const pos = menu ? placeMenu(menu.x, menu.y, options.length) : { left: 0, top: 0 };
  return (
    <AnimatePresence>
      {menu && options.length > 0 && (
        <motion.div
          ref={ref}
          role="menu"
          className="menu action-menu glass glass--sheet"
          style={pos}
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

/** 発言の長押し・右クリック: コピー・作業を見る（13.4） */
export function MessageMenu() {
  const menu = useUi((s) => s.messageMenu);
  const navigate = useNavigate();
  const close = () => useUi.getState().setMessageMenu(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(menu !== null, close, ref);
  const pos = menu ? placeMenu(menu.x, menu.y, menu.to ? 2 : 1) : { left: 0, top: 0 };
  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          ref={ref}
          role="menu"
          className="menu action-menu glass glass--sheet"
          style={pos}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.16 } }}
          transition={spring.snappy}
        >
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.text).catch(() => {});
              close();
            }}
          >
            <IconCopy size={18} />
            <span className="menu__label">{UI_TEXT_V2.conversation.copy}</span>
          </button>
          {menu.to && (
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                const to = menu.to!;
                close();
                void navigate({ to: "/i/$id", params: { id: to.instructionId }, search: to.sessionId ? { s: to.sessionId } : {} });
              }}
            >
              <IconEye size={18} />
              <span className="menu__label">{UI_TEXT_V2.conversation.viewWork}</span>
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 差し戻しのコメント（v1 3.5）。コメントは COO スレッドの CEO の発言になる（4.4） */
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

const ERROR_TOAST_MS = 4000;

/** トースト（取り消し・失敗・新しい発言）。下から snappy で出る */
export function ToastHost() {
  const toast = useToasts((s) => s.toast);
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (!toast) return;
    const ms = toast.kind === "undo" || toast.kind === "message" ? toast.duration : ERROR_TOAST_MS;
    const t = setTimeout(() => useToasts.getState().dismiss(toast.id), ms);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className={`toast-host ${toast?.kind === "message" ? "toast-host--top" : ""}`} aria-live="polite">
      <AnimatePresence mode="popLayout">
        {toast && (
          <motion.div
            key={toast.id}
            className={`toast glass glass--bar toast--${toast.kind}`}
            data-testid={toast.kind === "undo" ? TESTIDS.undoToast : toast.kind === "message" ? TESTIDS.toastMessage : TESTIDS.errorToast}
            role={toast.kind === "message" ? "button" : "status"}
            tabIndex={toast.kind === "message" ? 0 : undefined}
            initial={{ opacity: 0, y: toast.kind === "message" ? -24 : 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={spring.snappy}
            onClick={
              toast.kind === "message"
                ? () => {
                    useToasts.getState().dismiss(toast.id);
                    void navigate({ to: toast.to });
                  }
                : undefined
            }
          >
            <ToastBody toast={toast} onUndo={(id) => void performUndo(qc, id)} onResend={(clientId) => void deliver(qc, clientId)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToastBody({ toast, onUndo, onResend }: { toast: Toast; onUndo: (transitionId: string) => void; onResend: (clientId: string) => void }) {
  const dismiss = () => useToasts.getState().dismiss(toast.id);
  if (toast.kind === "undo") {
    return (
      <>
        <span className="toast__icon">
          <ActionIcon action={toast.action} size={18} />
        </span>
        <span className="toast__text">{ACTION_LABELS[toast.action]}</span>
        <button
          type="button"
          className="toast__button"
          data-testid={TESTIDS.undoButton}
          onClick={() => {
            dismiss();
            onUndo(toast.transitionId);
          }}
        >
          {UI_TEXT.undo}
        </button>
        <span className="toast__progress" style={{ animationDuration: `${toast.duration}ms` }} aria-hidden="true" />
      </>
    );
  }
  if (toast.kind === "message") {
    const role = toast.authorKind === "leader" ? "leader" : "coo";
    return (
      <>
        <span className={`role-dot role-dot--${role}`} aria-hidden="true" />
        <span className="toast__who">
          <span>{role === "leader" ? UI_TEXT_V2.roles.leader : UI_TEXT_V2.roles.coo}</span>
          {role === "leader" && toast.projectName && <span className="toast__project">{toast.projectName}</span>}
        </span>
        <span className="toast__preview">{toast.preview}</span>
        <span className="toast__progress" style={{ animationDuration: `${toast.duration}ms` }} aria-hidden="true" />
      </>
    );
  }
  if (toast.kind === "sendFailed") {
    return (
      <>
        <span className="toast__dot" aria-hidden="true" />
        <span className="toast__text">{UI_TEXT.sendFailed}</span>
        <button
          type="button"
          className="toast__button"
          onClick={() => {
            dismiss();
            onResend(toast.clientId);
          }}
        >
          {UI_TEXT.resend}
        </button>
      </>
    );
  }
  if (toast.kind === "info") {
    return <span className="toast__text">{toast.text}</span>;
  }
  return (
    <>
      <span className="toast__dot" aria-hidden="true" />
      <span className="toast__text">{UI_TEXT.updateFailed}</span>
    </>
  );
}
