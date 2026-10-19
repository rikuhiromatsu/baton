// プロジェクト案のカード（13.6）。作業場所を選び直して「立てる」。立てたら小さくなり、縁の光が 1 回走る
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { MEMBER_PROFILE_LABELS, TESTIDS, UI_TEXT_V2, type ProjectProposal } from "@baton/shared";
import { acceptProposal, declineProposal } from "../api/messages.ts";
import { useProposal, useRepos } from "../api/queries.ts";
import { relativeTime } from "../lib/time.ts";
import { spring } from "../motion/tokens.ts";
import { useDraft } from "../state/draft.ts";
import { focusComposer } from "./Composer.tsx";
import { IconBranch, IconCheck, IconFolder } from "./Icons.tsx";

type Choice = { kind: "baton" } | { kind: "repo"; repoPath: string };

function initialChoice(p: ProjectProposal): Choice {
  return p.workspace.kind === "repo" ? { kind: "repo", repoPath: p.workspace.repoPath } : { kind: "baton" };
}

export function ProposalCard({ proposalId, now }: { proposalId: string; now: number }) {
  const q = useProposal(proposalId);
  const p = q.data;
  if (!p) {
    // 読めないとき（古い Worker・消えた案）は見出しだけの小さなカードにする
    if (q.isError)
      return (
        <article className="proposal-card proposal-card--superseded glass glass--card" data-testid={TESTIDS.proposalCard} data-proposal-id={proposalId} data-status="superseded">
          <header className="proposal__head">
            <span className="proposal__eyebrow">{UI_TEXT_V2.proposal.title}</span>
          </header>
        </article>
      );
    return (
      <div className="proposal-card proposal-card--loading glass glass--card" aria-busy="true">
        <div className="sk sk--line" />
        <div className="sk sk--line sk--short" />
      </div>
    );
  }
  return <ProposalCardBody proposal={p} now={now} />;
}

export function ProposalCardBody({ proposal: p, now }: { proposal: ProjectProposal; now: number }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<Choice>(() => initialChoice(p));
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState(0);
  const pending = p.status === "pending";
  const repos = useRepos(pending);
  useEffect(() => {
    if (p.status === "accepted") setSweep((n) => n + 1);
  }, [p.status]);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    const ws = choice.kind === "repo" ? { kind: "repo" as const, repoPath: choice.repoPath } : { kind: "baton" as const };
    await acceptProposal(qc, p, ws);
    setBusy(false);
  };
  const revise = () => {
    const prefix = `${UI_TEXT_V2.proposal.title}${UI_TEXT_V2.conversation.about}: `;
    const cur = useDraft.getState().texts.coo ?? "";
    useDraft.getState().setText("coo", cur.startsWith(prefix) ? cur : `${prefix}${cur}`);
    requestAnimationFrame(() => focusComposer());
  };

  const team = (
    <ul className="proposal__team">
      <li className="proposal__agent">
        <span className="role-dot role-dot--leader" aria-hidden="true" />
        <span className="proposal__agent-name">{p.leader.name}</span>
        <span className="proposal__agent-role">{UI_TEXT_V2.roles.leader}</span>
      </li>
      {p.members.map((m) => (
        <li key={m.name} className="proposal__agent">
          <span className="role-dot role-dot--member" aria-hidden="true" />
          <span className="proposal__agent-name">{m.name}</span>
          <span className="proposal__agent-role">{MEMBER_PROFILE_LABELS[m.profile]}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <motion.article
      layout
      className={`proposal-card glass glass--card proposal-card--${p.status}`}
      data-testid={TESTIDS.proposalCard}
      data-proposal-id={p.id}
      data-status={p.status}
      initial={{ opacity: 0, scale: 0.98, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={spring.gentle}
    >
      {sweep > 0 && <span key={sweep} className="proposal-card__sweep" aria-hidden="true" />}
      <header className="proposal__head">
        <span className="proposal__eyebrow">{UI_TEXT_V2.proposal.title}</span>
        <h3 className="proposal__name">{p.name}</h3>
        {!pending && (
          <span className={`proposal__state proposal__state--${p.status}`}>
            {p.status === "accepted" ? <IconCheck size={14} /> : null}
            <span>{p.status === "accepted" ? UI_TEXT_V2.proposal.accepted : UI_TEXT_V2.proposal.declined}</span>
          </span>
        )}
      </header>
      <AnimatePresence initial={false}>
        {pending ? (
          <motion.div key="body" className="proposal__body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0, transition: { duration: 0.22 } }}>
            <section className="proposal__section">
              <h4 className="proposal__label">{UI_TEXT_V2.proposal.goal}</h4>
              <p className="proposal__goal">{p.goal}</p>
            </section>
            <section className="proposal__section">
              <h4 className="proposal__label">{UI_TEXT_V2.proposal.workspace}</h4>
              <div className="segmented" role="radiogroup" data-testid={TESTIDS.proposalWorkspace}>
                {(["baton", "repo"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={choice.kind === k}
                    className="segmented__item"
                    data-value={k}
                    onClick={() => {
                      if (k === "baton") setChoice({ kind: "baton" });
                      else {
                        const first = p.workspace.kind === "repo" ? p.workspace.repoPath : (repos.data?.items.find((r) => !r.projectId)?.path ?? repos.data?.items[0]?.path);
                        if (first) setChoice({ kind: "repo", repoPath: first });
                        else setChoice({ kind: "repo", repoPath: "" });
                      }
                    }}
                  >
                    {choice.kind === k && <motion.span layoutId={`seg-${p.id}`} className="segmented__thumb" transition={spring.snappy} />}
                    <span className="segmented__label">
                      {k === "baton" ? <IconFolder size={14} /> : <IconBranch size={14} />}
                      {k === "baton" ? UI_TEXT_V2.proposal.baton : UI_TEXT_V2.proposal.repo}
                    </span>
                  </button>
                ))}
              </div>
              <AnimatePresence initial={false}>
                {choice.kind === "repo" && (
                  <motion.ul
                    className="repo-options"
                    role="radiogroup"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={spring.smooth}
                  >
                    {(repos.data?.items ?? []).map((r) => {
                      const selected = choice.repoPath === r.path;
                      return (
                        <li key={r.path}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className="repo-option"
                            data-testid={TESTIDS.proposalRepoOption}
                            data-path={r.path}
                            onClick={() => setChoice({ kind: "repo", repoPath: r.path })}
                          >
                            <span className="repo-option__radio" aria-hidden="true">
                              {selected && <motion.span layoutId={`repo-sel-${p.id}`} className="repo-option__radio-dot" transition={spring.snappy} />}
                            </span>
                            <span className="repo-option__name">{r.name}</span>
                            <span className="repo-option__meta">
                              {r.headSha && <code>{r.headSha.slice(0, 7)}</code>}
                              {r.lastCommitAt && <span>{relativeTime(r.lastCommitAt, now)}</span>}
                              {r.dirty && <span className="repo-option__dirty">{UI_TEXT_V2.proposal.dirty}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </motion.ul>
                )}
              </AnimatePresence>
            </section>
            <section className="proposal__section">
              <h4 className="proposal__label">{UI_TEXT_V2.proposal.team}</h4>
              {team}
            </section>
            <div className="proposal__actions">
              <motion.button
                type="button"
                className="primary-button"
                data-testid={TESTIDS.proposalAccept}
                disabled={busy || (choice.kind === "repo" && !choice.repoPath)}
                whileTap={{ scale: 0.96 }}
                transition={spring.pop}
                onClick={() => void accept()}
              >
                {UI_TEXT_V2.proposal.accept}
              </motion.button>
              <button type="button" className="ghost-button" data-testid={TESTIDS.proposalRevise} onClick={revise}>
                {UI_TEXT_V2.proposal.revise}
              </button>
              <button type="button" className="ghost-button ghost-button--quiet" onClick={() => void declineProposal(qc, p)}>
                {UI_TEXT_V2.proposal.declined}
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="compact" className="proposal__compact" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle}>
            <span className="proposal__compact-ws">
              {p.workspace.kind === "repo" ? <IconBranch size={14} /> : <IconFolder size={14} />}
              <span>{p.workspace.kind === "repo" ? p.workspace.repoName : UI_TEXT_V2.proposal.baton}</span>
            </span>
            {p.status === "accepted" && p.projectId && (
              <Link to="/p/$projectId" params={{ projectId: p.projectId }} className="chip-link">
                {p.name}
              </Link>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}
