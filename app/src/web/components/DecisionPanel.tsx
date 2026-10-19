// 判断の質問・選択肢・自由入力（5.7・7.5）
import { useState } from "react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT, type Decision } from "@baton/shared";
import { answerDecision } from "../api/actions.ts";
import { spring } from "../motion/tokens.ts";

export function DecisionPanel({ decision }: { decision: Decision }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (answer: string, optionIndex?: number) => {
    if (busy || !answer.trim()) return;
    setBusy(true);
    const ok = await answerDecision(qc, decision.instructionId, decision.id, { answer: answer.trim(), optionIndex });
    setBusy(false);
    if (ok) setText("");
  };

  return (
    <motion.section
      className="decision glass glass--card"
      data-testid={TESTIDS.decisionPanel}
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={spring.gentle}
    >
      <span className="decision__pulse" aria-hidden="true" />
      <h3 className="section__label section__label--decision">{UI_TEXT.sectionDecision}</h3>
      <p className="decision__question">{decision.question}</p>
      {decision.options.length > 0 && (
        <div className="decision__options">
          {decision.options.map((opt, i) => (
            <motion.button
              key={i}
              type="button"
              className="option-button"
              data-testid={TESTIDS.decisionOption(i)}
              disabled={busy}
              whileTap={{ scale: 0.97 }}
              transition={spring.snappy}
              onClick={() => void send(opt, i)}
            >
              {opt}
            </motion.button>
          ))}
        </div>
      )}
      <div className="decision__free">
        <textarea
          className="field"
          rows={2}
          data-testid={TESTIDS.decisionInput}
          aria-label={UI_TEXT.answerAria}
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="button" className="primary-button primary-button--decision" data-testid={TESTIDS.decisionSubmit} disabled={busy || !text.trim()} onClick={() => void send(text)}>
          {UI_TEXT.answerSubmit}
        </button>
      </div>
    </motion.section>
  );
}
