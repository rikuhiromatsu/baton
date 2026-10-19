// 変更（13.7）。統合用の差分のファイル一覧 → unified。既存リポジトリはブランチ名と元。Codex の指摘があれば上に要約
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TESTIDS, UI_TEXT, UI_TEXT_V2, type DiffStatEntry, type Workspace, type WorkspaceDiff } from "@baton/shared";
import { parsePatch, type DiffFile } from "../lib/diff.ts";
import { spring } from "../motion/tokens.ts";
import { useTailnet } from "../state/tailnet.ts";
import { IconBranch, IconChevronRight, IconExternal, IconFolder } from "./Icons.tsx";

export function BranchChip({ workspace, batonOnly }: { workspace: Workspace | null; batonOnly: boolean }) {
  return (
    <span className="branch-chip" data-testid={TESTIDS.branchChip}>
      {workspace && !batonOnly ? <IconBranch size={13} /> : <IconFolder size={13} />}
      <span>{workspace && !batonOnly ? workspace.branch : UI_TEXT_V2.proposal.baton}</span>
    </span>
  );
}

function FileBlock({ stat, file, defaultOpen }: { stat: DiffStatEntry; file: DiffFile | undefined; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="diff-file" data-testid={TESTIDS.diffFile} data-path={stat.path}>
      <button type="button" className="diff-file__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="diff-file__chev" aria-hidden="true">
          <IconChevronRight size={14} />
        </motion.span>
        <span className={`diff-file__change diff-file__change--${stat.change}`}>{stat.change}</span>
        <span className="diff-file__path">{stat.path}</span>
        <span className="diff-file__stat">
          <span className="add">+{stat.added}</span>
          <span className="del">−{stat.removed}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && file && (
          <motion.div className="diff-view" data-testid={TESTIDS.diffView} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
            <table className="diff-table">
              <tbody>
                {file.lines.map((l, i) => (
                  <tr key={i} className={`diff-row diff-row--${l.kind}`}>
                    <td className="diff-row__no">{l.oldNo ?? ""}</td>
                    <td className="diff-row__no">{l.newNo ?? ""}</td>
                    <td className="diff-row__text">
                      <span className="diff-row__sign" aria-hidden="true">
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                      </span>
                      {l.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

export function DiffView({ diff, workspace, batonOnly }: { diff: WorkspaceDiff | undefined; workspace: Workspace | null; batonOnly: boolean }) {
  const files = useMemo(() => parsePatch(diff?.patch ?? null), [diff?.patch]);
  const tailnet = useTailnet();
  const stats = diff?.files ?? workspace?.diffStat ?? [];
  const ws = diff?.workspace ?? workspace;
  return (
    <div className="diff-pane">
      <div className="diff-pane__head">
        <BranchChip workspace={ws} batonOnly={batonOnly} />
        {ws && !batonOnly && (
          <span className="diff-pane__base">
            <span aria-hidden="true">←</span>
            <code>{ws.baseRef}</code>
          </span>
        )}
      </div>
      {diff?.reviewSummary && (
        <div className="review-summary glass glass--card">
          <span className="review-summary__label">{UI_TEXT_V2.transcript.codexReview}</span>
          <p>{diff.reviewSummary}</p>
        </div>
      )}
      {stats.length === 0 ? (
        <p className="empty-line">{UI_TEXT_V2.diff.noDiff}</p>
      ) : (
        <ul className="diff-files">
          {stats.map((s, i) => (
            <FileBlock key={s.path} stat={s} file={files.find((f) => f.path === s.path)} defaultOpen={i === 0 && stats.length <= 3} />
          ))}
        </ul>
      )}
      {diff?.truncated && tailnet.ok && tailnet.url && ws && (
        <a className="chip-button" href={`${tailnet.url}/diff/${encodeURIComponent(ws.id)}`} target="_blank" rel="noopener noreferrer">
          <IconExternal size={15} />
          <span>{UI_TEXT.openOnMini}</span>
        </a>
      )}
    </div>
  );
}
