// 承認カード（7.6・13.7・D-53）。紫のふち。`許可` / `拒否`（理由を書いてから）。秘書の案があれば添える。
// 中断（interrupted）で止まったメンバーは `再開`。フリックだけでは許可しない
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT_V2, type Decision } from "@baton/shared";
import { answerDecision } from "../api/actions.ts";
import { spring } from "../motion/tokens.ts";
import { IconCheck, IconHand, IconRetry, IconX } from "./Icons.tsx";

function commandOf(d: Decision): string {
  const input = d.toolInput ?? {};
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  return d.question || JSON.stringify(input);
}

export function ApprovalCard({ decision, compact = false }: { decision: Decision; compact?: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const open = decision.status === "open";
  const isResume = decision.kind === "interrupted" && !decision.toolName;

  const allow = async () => {
    if (busy) return;
    setBusy(true);
    await answerDecision(qc, decision.instructionId, decision.id, { verdict: "allow" });
    setBusy(false);
  };
  const deny = async () => {
    if (busy) return;
    if (!reasonOpen) {
      setReasonOpen(true);
      return;
    }
    setBusy(true);
    await answerDecision(qc, decision.instructionId, decision.id, reason.trim() ? { verdict: "deny", answer: reason.trim() } : { verdict: "deny" });
    setBusy(false);
  };
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    await answerDecision(qc, decision.instructionId, decision.id, { answer: UI_TEXT_V2.transcript.resume });
    setBusy(false);
  };

  return (
    <motion.section
      layout
      className={`approval-card glass glass--card ${open ? "approval-card--open" : "approval-card--done"} ${compact ? "approval-card--compact" : ""}`}
      data-testid={TESTIDS.approvalCard}
      data-decision-id={decision.id}
      data-status={decision.status}
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={spring.gentle}
    >
      {open && <span className="approval-card__pulse" aria-hidden="true" />}
      <header className="approval-card__head">
        <span className="approval-card__icon" aria-hidden="true">
          {isResume ? <IconRetry size={16} /> : <IconHand size={16} />}
        </span>
        <span className="approval-card__label">{isResume ? UI_TEXT_V2.transcript.resume : UI_TEXT_V2.approval.approve}</span>
        {decision.toolName && <code className="approval-card__tool">{decision.toolName}</code>}
        {!open && decision.verdict && (
          <span className={`approval-card__verdict approval-card__verdict--${decision.verdict}`}>
            {decision.verdict === "allow" ? <IconCheck size={14} /> : <IconX size={14} />}
            <span>{decision.verdict === "allow" ? UI_TEXT_V2.approval.allow : UI_TEXT_V2.approval.deny}</span>
          </span>
        )}
      </header>
      {!isResume && <pre className="approval-card__command">{commandOf(decision)}</pre>}
      {isResume && <p className="approval-card__question">{decision.question}</p>}
      {decision.suggestion && (
        <div className="approval-card__suggestion" data-testid={TESTIDS.approvalSuggestion}>
          <span className="approval-card__suggestion-label">{UI_TEXT_V2.conversation.secretarySuggestion}</span>
          {decision.suggestionVerdict && <span className={`approval-card__sv approval-card__sv--${decision.suggestionVerdict}`}>{decision.suggestionVerdict === "allow" ? UI_TEXT_V2.approval.allow : UI_TEXT_V2.approval.deny}</span>}
          <span className="approval-card__suggestion-text">{decision.suggestion}</span>
        </div>
      )}
      {open && (
        <>
          <AnimatePresence initial={false}>
            {reasonOpen && (
              <motion.div className="approval-card__reason" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
                <textarea
                  className="field"
                  rows={2}
                  data-testid={TESTIDS.approvalReason}
                  aria-label={UI_TEXT_V2.approval.reason}
                  value={reason}
                  maxLength={2000}
                  autoFocus
                  onChange={(e) => setReason(e.target.value)}
                />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="approval-card__actions">
            {isResume ? (
              <motion.button type="button" className="primary-button primary-button--decision" data-testid={TESTIDS.resumeButton} disabled={busy} whileTap={{ scale: 0.96 }} transition={spring.pop} onClick={() => void resume()}>
                <IconRetry size={16} />
                <span>{UI_TEXT_V2.transcript.resume}</span>
              </motion.button>
            ) : (
              <>
                <motion.button type="button" className="primary-button primary-button--decision" data-testid={TESTIDS.approvalAllow} disabled={busy} whileTap={{ scale: 0.96 }} transition={spring.pop} onClick={() => void allow()}>
                  <IconCheck size={16} />
                  <span>{UI_TEXT_V2.approval.allow}</span>
                </motion.button>
                <motion.button type="button" className="ghost-button ghost-button--danger" data-testid={TESTIDS.approvalDeny} disabled={busy} whileTap={{ scale: 0.96 }} transition={spring.pop} onClick={() => void deny()}>
                  <IconX size={16} />
                  <span>{UI_TEXT_V2.approval.deny}</span>
                </motion.button>
              </>
            )}
          </div>
        </>
      )}
    </motion.section>
  );
}
