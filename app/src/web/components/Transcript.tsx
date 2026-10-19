// トランスクリプト（13.7）。標準は道具の呼び出しを 1 行に、読み取り系の連続を「n 件の操作」に。詳細はすべて開く。
// Claude Code デスクトップのトランスクリプトに寄せる
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TESTIDS, UI_TEXT_V2, type AgentSessionSummary, type Decision, type TranscriptItem } from "@baton/shared";
import { useTranscriptItem } from "../api/queries.ts";
import { parseHunks } from "../lib/diff.ts";
import { buildRows, patchPreview, resultStats, type ToolPair, type TodoEntry, type TranscriptRow, type ViewMode } from "../lib/transcript-view.ts";
import { spring } from "../motion/tokens.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { IconBrain, IconCheck, IconChevronRight, IconX, ToolIcon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";

const VIRTUALIZE_AFTER = 60;

function runnerLabel(text: string, role: AgentSessionSummary["role"] | null): string | null {
  if (/^\[メンバーの結果\]/.test(text)) return UI_TEXT_V2.transcript.memberResults;
  if (/^\[CEO の回答\]/.test(text)) return UI_TEXT_V2.transcript.ceoAnswer;
  if (/^\[COO\]/.test(text)) return UI_TEXT_V2.transcript.fromCoo;
  if (/^\[(リーダー|タスク)\]/.test(text)) return UI_TEXT_V2.transcript.fromLeader;
  if (role === "member") return UI_TEXT_V2.transcript.fromLeader;
  if (role === "leader") return UI_TEXT_V2.transcript.fromCoo;
  return null;
}

function bodyText(item: TranscriptItem | null): string {
  if (!item) return "";
  const b = item.body as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (typeof b.stdout === "string" || typeof b.stderr === "string") return [b.stdout, b.stderr].filter((x) => typeof x === "string" && x).join("\n");
  return "";
}

function inputText(item: TranscriptItem | null): string {
  if (!item) return "";
  const input = (item.body as { input?: Record<string, unknown> }).input;
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  return JSON.stringify(input, null, 2);
}

function DiffLines({ lines, more }: { lines: string[]; more: number }) {
  const parsed = parseHunks(lines.join("\n"));
  return (
    <div className="mini-diff">
      {parsed.map((l, i) => (
        <div key={i} className={`mini-diff__line mini-diff__line--${l.kind}`}>
          <span className="mini-diff__sign" aria-hidden="true">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "hunk" ? "" : " "}
          </span>
          <span className="mini-diff__text">{l.kind === "hunk" ? l.text : l.text || " "}</span>
        </div>
      ))}
      {more > 0 && <div className="mini-diff__more">+{more}</div>}
    </div>
  );
}

function FullText({ itemId, fallback }: { itemId: string; fallback: string }) {
  const [want, setWant] = useState(false);
  const q = useTranscriptItem(want ? itemId : null);
  const text = want && q.data ? bodyText(q.data) || fallback : fallback;
  const lines = text.split("\n");
  const shown = want ? lines : lines.slice(0, 40);
  return (
    <>
      <pre className="tool-row__output">{shown.join("\n")}</pre>
      {!want && lines.length > 40 && (
        <button type="button" className="chip-button" onClick={() => setWant(true)}>
          {UI_TEXT_V2.transcript.fullText}
        </button>
      )}
    </>
  );
}

function ToolRow({ pair, mode, seqKey, live = false }: { pair: ToolPair; mode: ViewMode; seqKey: number; live?: boolean }) {
  const [open, setOpen] = useState(mode === "detailed");
  useEffect(() => setOpen(mode === "detailed"), [mode]);
  const tool = pair.use?.toolName ?? pair.result?.toolName ?? null;
  const error = pair.result?.isError ?? false;
  const pending = live && pair.use !== null && pair.result === null;
  const summary = (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") && pair.result ? pair.result.summary : (pair.use?.summary ?? pair.result?.summary ?? "");
  const preview = patchPreview(pair.result, mode);
  return (
    <div className={`tool-row ${error ? "tool-row--error" : ""}`} data-testid={TESTIDS.transcriptItem} data-kind="tool_use" data-seq={seqKey} data-tool={tool ?? ""}>
      <button type="button" className="tool-row__line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tool-row__icon" aria-hidden="true">
          <ToolIcon tool={tool} />
        </span>
        <span className="tool-row__summary">{summary}</span>
        <span className={`tool-row__mark ${pending ? "tool-row__mark--pending" : error ? "tool-row__mark--error" : "tool-row__mark--ok"}`} aria-hidden="true">
          {pending ? <span className="spinner spinner--xs" /> : !pair.result ? null : error ? <IconX size={13} /> : <IconCheck size={13} />}
        </span>
        <motion.span className="tool-row__chev" animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} aria-hidden="true">
          <IconChevronRight size={14} />
        </motion.span>
      </button>
      {preview && !open && <DiffLines lines={preview.lines} more={preview.more} />}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="tool-row__detail" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
            {pair.use && tool !== "Edit" && tool !== "Write" && <pre className="tool-row__input">{inputText(pair.use)}</pre>}
            {preview ? <DiffLines lines={preview.lines} more={preview.more} /> : pair.result ? <FullText itemId={pair.result.id} fallback={bodyText(pair.result)} /> : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function GroupRow({ pairs, mode, seqKey }: { pairs: ToolPair[]; mode: ViewMode; seqKey: number }) {
  const [open, setOpen] = useState(false);
  const tools = [...new Set(pairs.map((p) => p.use?.toolName ?? p.result?.toolName ?? ""))];
  return (
    <div className="tool-group" data-testid={TESTIDS.transcriptGroup}>
      <button type="button" className="tool-row__line tool-group__line" data-testid={TESTIDS.transcriptExpand} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tool-group__icons" aria-hidden="true">
          {tools.slice(0, 3).map((t) => (
            <span key={t} className="tool-row__icon">
              <ToolIcon tool={t} />
            </span>
          ))}
        </span>
        <span className="tool-row__summary">
          <span className="num">{pairs.length}</span>
          <span>{UI_TEXT_V2.transcript.operations}</span>
        </span>
        <motion.span className="tool-row__chev" animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} aria-hidden="true">
          <IconChevronRight size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="tool-group__items" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
            {pairs.map((p, i) => (
              <ToolRow key={i} pair={p} mode={mode} seqKey={p.use?.seq ?? p.result?.seq ?? seqKey + i} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TodoCard({ todos }: { todos: TodoEntry[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="todo-card glass glass--card">
      <div className="todo-card__progress" aria-hidden="true">
        <motion.span className="todo-card__bar" initial={false} animate={{ scaleX: todos.length ? done / todos.length : 0 }} transition={spring.smooth} />
      </div>
      <ul className="todo-list" data-testid={TESTIDS.todoList}>
        {todos.map((t, i) => (
          <li key={i} className={`todo-item todo-item--${t.status}`} data-testid={TESTIDS.todoItem} data-status={t.status}>
            <span className="todo-item__box" aria-hidden="true">
              {t.status === "completed" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <motion.path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3 }} />
                </svg>
              ) : t.status === "in_progress" ? (
                <span className="todo-item__spin" />
              ) : null}
            </span>
            <span className="todo-item__text">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutputCard({ item, mode }: { item: TranscriptItem; mode: ViewMode }) {
  const value = (item.body as { value?: Record<string, unknown> }).value ?? {};
  const actions = Array.isArray(value.actions) ? (value.actions as Record<string, unknown>[]) : [];
  const lines: string[] = [];
  if (typeof value.summary === "string") lines.push(value.summary);
  if (typeof value.reason === "string") lines.push(value.reason);
  if (typeof value.question === "string") lines.push(value.question);
  for (const a of actions) {
    const t = typeof a.type === "string" ? a.type : "";
    const detail = typeof a.title === "string" ? a.title : typeof a.summary === "string" ? a.summary : typeof a.message === "string" ? a.message : Array.isArray(a.tasks) ? (a.tasks as { title?: string }[]).map((x) => x.title ?? "").join(" / ") : "";
    lines.push(`${t}${detail ? ` · ${detail.replace(/\*\*/g, "").replace(/\s+/g, " ")}` : ""}`);
  }
  return (
    <div className="output-card" data-testid={TESTIDS.transcriptItem} data-kind="output" data-seq={item.seq} data-mode={mode}>
      <span className="output-card__label">{UI_TEXT_V2.transcript.conclusion}</span>
      {lines.map((l, i) => (
        <p key={i} className="output-card__line">
          {l}
        </p>
      ))}
      {mode === "detailed" && <pre className="output-card__json">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

const Row = memo(function Row({ row, mode, role, decisions, live }: { row: TranscriptRow; mode: ViewMode; role: AgentSessionSummary["role"] | null; decisions: Map<string, Decision>; live: boolean }) {
  if (row.kind === "tool") return <ToolRow pair={row.pair} mode={mode} seqKey={row.pair.use?.seq ?? row.pair.result?.seq ?? 0} live={live} />;
  if (row.kind === "group") return <GroupRow pairs={row.pairs} mode={mode} seqKey={row.pairs[0]?.use?.seq ?? 0} />;
  if (row.kind === "todo")
    return (
      <div data-testid={TESTIDS.transcriptItem} data-kind="tool_use" data-tool="TodoWrite" data-seq={row.item.seq} className="t-todo">
        <TodoCard todos={row.todos} />
      </div>
    );
  const it = row.item;
  const common = { "data-testid": TESTIDS.transcriptItem, "data-kind": it.kind, "data-seq": it.seq, "data-tool": it.toolName ?? "" };
  switch (it.kind) {
    case "user": {
      const text = bodyText(it);
      if (it.author === "ceo")
        return (
          <div className="t-user t-user--ceo" {...common}>
            <div className="bubble bubble--ceo">
              <Markdown text={text} />
            </div>
          </div>
        );
      const label = runnerLabel(text, role);
      return (
        <div className="t-user t-user--runner" {...common}>
          {label && <span className="t-user__label">{label}</span>}
          <p className="t-user__text">{text}</p>
        </div>
      );
    }
    case "text":
      return (
        <div className="t-text" {...common}>
          <Markdown text={bodyText(it)} />
        </div>
      );
    case "thinking":
      return (
        <details className="t-thinking" {...common}>
          <summary>
            <IconBrain size={14} />
            <span>{UI_TEXT_V2.transcript.thought}</span>
          </summary>
          <p>{bodyText(it)}</p>
        </details>
      );
    case "output":
      return <OutputCard item={it} mode={mode} />;
    case "approval": {
      const id = (it.body as { decisionId?: unknown }).decisionId;
      const d = typeof id === "string" ? decisions.get(id) : undefined;
      return (
        <div className="t-approval" {...common}>
          {d ? <ApprovalCard decision={d} compact /> : <p className="t-line">{it.summary}</p>}
        </div>
      );
    }
    case "denied":
      return (
        <div className="t-line t-line--denied" {...common}>
          <IconX size={13} />
          <span>{it.summary}</span>
        </div>
      );
    case "system":
      return (
        <div className="t-system" {...common}>
          <span className="t-system__line" aria-hidden="true" />
          <span>{it.summary}</span>
          <span className="t-system__line" aria-hidden="true" />
        </div>
      );
    case "result": {
      const st = resultStats(it);
      return (
        <div className="t-result" {...common}>
          <span>{UI_TEXT_V2.transcript.end}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span className="num">{st.minutes}</span>
          <span>{UI_TEXT_V2.transcript.minutes}</span>
          <span className="num">{st.seconds}</span>
          <span>{UI_TEXT_V2.transcript.seconds}</span>
          {st.turns !== null && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span className="num">{st.turns}</span>
              <span>{UI_TEXT_V2.transcript.turns}</span>
            </>
          )}
          {mode === "detailed" && st.costUsdEst !== null && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span className="num">${st.costUsdEst.toFixed(2)}</span>
            </>
          )}
        </div>
      );
    }
    default:
      return (
        <div className={`t-line t-line--${it.kind}`} {...common}>
          <span>{it.summary || bodyText(it)}</span>
        </div>
      );
  }
});

type Props = {
  items: readonly TranscriptItem[];
  mode: ViewMode;
  session: AgentSessionSummary | null;
  decisions: readonly Decision[];
  /** 下書きの送信待ち（追加の依頼） */
  pending?: { id: string; body: string }[];
  hasMoreBefore: boolean;
  onLoadOlder: () => void;
  bottomInset?: number;
};

export function Transcript({ items, mode, session, decisions, pending = [], hasMoreBefore, onLoadOlder, bottomInset = 160 }: Props) {
  const rows = useMemo(() => buildRows(items, mode), [items, mode]);
  const decisionMap = useMemo(() => new Map(decisions.map((d) => [d.id, d])), [decisions]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loading = useRef(false);
  const before = useRef<{ h: number; first: number } | null>(null);
  const virtual = rows.length > VIRTUALIZE_AFTER;
  const v = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  });
  const running = session?.status === "running";

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (before.current && items[0] && items[0].seq < before.current.first) {
      el.scrollTop += el.scrollHeight - before.current.h;
      before.current = null;
      return;
    }
    if (atBottom.current) {
      if (virtual) v.scrollToIndex(rows.length - 1, { align: "end" });
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        if (atBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, pending.length, session?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 160 && hasMoreBefore && !loading.current && items[0]) {
      loading.current = true;
      before.current = { h: el.scrollHeight, first: items[0].seq };
      Promise.resolve(onLoadOlder()).finally(() => {
        loading.current = false;
      });
    }
  };

  const body = virtual ? (
    <div className="transcript__list transcript__list--virtual" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((vi) => (
        <div key={vi.key} data-index={vi.index} ref={v.measureElement} className="vrow" style={{ transform: `translateY(${vi.start}px)` }}>
          <Row row={rows[vi.index]!} mode={mode} role={session?.role ?? null} decisions={decisionMap} live={running} />
        </div>
      ))}
    </div>
  ) : (
    <div className="transcript__list">
      {rows.map((r) => (
        <motion.div key={r.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle}>
          <Row row={r} mode={mode} role={session?.role ?? null} decisions={decisionMap} live={running} />
        </motion.div>
      ))}
    </div>
  );

  return (
    <div className="transcript" data-testid={TESTIDS.transcript} data-mode={mode} ref={scrollRef} onScroll={onScroll}>
      <div className="transcript__inner" style={{ paddingBottom: bottomInset }}>
        {hasMoreBefore && (
          <div className="thread__older" aria-hidden="true">
            <span className="spinner" />
          </div>
        )}
        {body}
        {pending.map((p) => (
          <div key={p.id} className="t-user t-user--ceo t-user--pending">
            <div className="bubble bubble--ceo" data-local="sending">
              <Markdown text={p.body} />
            </div>
          </div>
        ))}
        {running && (
          <div className="t-running">
            <span className="typing__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <AnimatePresence mode="wait">
              <motion.span key={session?.activity ?? "think"} className="typing__activity" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={spring.gentle}>
                {session?.activity ?? UI_TEXT_V2.conversation.thinking}
              </motion.span>
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
