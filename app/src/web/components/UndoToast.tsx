// 取り消しトースト（5 秒のプログレス付き）と失敗のトースト（7.5・7.6）
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { ACTION_LABELS, TESTIDS, UI_TEXT } from "@baton/shared";
import { deliver, performUndo } from "../api/actions.ts";
import { spring } from "../motion/tokens.ts";
import { useToasts, type Toast } from "../state/toasts.ts";
import { ActionIcon } from "./Icons.tsx";

const ERROR_TOAST_MS = 4000;

export function ToastHost() {
  const toast = useToasts((s) => s.toast);
  const qc = useQueryClient();

  useEffect(() => {
    if (!toast) return;
    const ms = toast.kind === "undo" ? toast.duration : ERROR_TOAST_MS;
    const t = setTimeout(() => useToasts.getState().dismiss(toast.id), ms);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="toast-host" aria-live="polite">
      <AnimatePresence mode="popLayout">
        {toast && (
          <motion.div
            key={toast.id}
            className={`toast glass glass--bar toast--${toast.kind}`}
            data-testid={toast.kind === "undo" ? TESTIDS.undoToast : TESTIDS.errorToast}
            role="status"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={spring.snappy}
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
  return (
    <>
      <span className="toast__dot" aria-hidden="true" />
      <span className="toast__text">{UI_TEXT.updateFailed}</span>
    </>
  );
}
