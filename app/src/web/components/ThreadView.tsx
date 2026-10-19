// 会話の一覧（13.4）。最新 100 件、上へで before=、追従と「最新へ」、長いときは仮想化。
// 見えていてフォーカスがあり、一番下付近まで見えたら既読（4.8）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT_V2, type SidebarOutput, type ThreadMessage } from "@baton/shared";
import { qk } from "../api/keys.ts";
import { lastServerSeq, leaveThread, markThreadRead, mergeOutbox, type DisplayMessage } from "../api/messages.ts";
import { loadOlderMessages, useMessages, useSidebar } from "../api/queries.ts";
import { subscribeThread } from "../api/ws.ts";
import { useNow } from "../lib/useNow.ts";
import { spring } from "../motion/tokens.ts";
import { useOutbox } from "../state/outbox.ts";
import { useStreams } from "../state/streams.ts";
import { useUi } from "../state/ui.ts";
import { IconChevronDown } from "./Icons.tsx";
import { MessageItem, type AuthorInfo, type MessageContext } from "./Message.tsx";
import { SkeletonBubbles } from "./SkeletonScreen.tsx";

// フォーカスの有無は blur・focus のイベントで追う（document.hasFocus はヘッドレスで当てにならない）
let windowFocused = true;
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => void (windowFocused = false));
  window.addEventListener("focus", () => void (windowFocused = true));
}
export function isPageActive(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return windowFocused;
}

/** これより多いときだけ仮想化する（少ないときは描いたほうが動きがなめらか） */
export const VIRTUALIZE_AFTER = 60;
const NEAR_BOTTOM_PX = 140;
const GROUP_MS = 5 * 60 * 1000;

/** 同じ書き手が続いたら名前を省く */
export function isGrouped(prev: ThreadMessage | undefined, m: ThreadMessage): boolean {
  if (!prev) return false;
  if (m.authorKind === "ceo" || m.authorKind === "system") return false;
  if (prev.authorKind !== m.authorKind || prev.authorAgentId !== m.authorAgentId) return false;
  if (!["chat", "report", "project_proposal"].includes(prev.kind) || !["chat", "report", "project_proposal"].includes(m.kind)) return false;
  return m.createdAt - prev.createdAt < GROUP_MS;
}

function useAuthorOf(): (agentId: string | null) => AuthorInfo {
  const sidebar = useSidebar();
  return useMemo(() => {
    const map = new Map<string, AuthorInfo>();
    for (const it of (sidebar.data as SidebarOutput | undefined)?.items ?? []) {
      for (const a of it.project.agents) map.set(a.id, { projectId: it.project.id, projectName: it.project.name });
    }
    return (id: string | null) => (id ? (map.get(id) ?? { projectId: null, projectName: null }) : { projectId: null, projectName: null });
  }, [sidebar.data]);
}

type Props = {
  threadId: string;
  kind: "coo" | "leader";
  projectId: string | null;
  /** 一覧の上に出すもの（プロジェクトの帯など） */
  header?: React.ReactNode;
  /** 一覧の下の余白（入力欄の高さ） */
  bottomInset?: number;
};

export function ThreadView({ threadId, kind, projectId, header, bottomInset = 140 }: Props) {
  const qc = useQueryClient();
  const q = useMessages(qc, threadId);
  const outbox = useOutbox((s) => s.items);
  const now = useNow();
  const authorOf = useAuthorOf();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showPill, setShowPill] = useState(false);
  const loadingOlder = useRef(false);
  const firstSeq = useRef<number | null>(null);
  const heightBefore = useRef<number | null>(null);

  // 届いた発言（送信待ちは除く）
  const merged = useMemo(() => {
    const server = q.data?.items ?? [];
    return mergeOutbox(server, Object.values(outbox), threadId);
  }, [q.data, outbox, threadId]);
  useEffect(() => {
    for (const c of merged.delivered) useOutbox.getState().remove(c);
  }, [merged.delivered]);
  const items: DisplayMessage[] = merged.items;
  const streamingIds = items.filter((m) => m.status === "streaming").map((m) => m.id);
  const streamTick = useStreams((s) => streamingIds.map((id) => s.byId[id]?.text.length ?? 0).join(","));

  const ctx: MessageContext = useMemo(() => ({ now, authorOf, threadProjectId: projectId, threadKind: kind }), [now, authorOf, projectId, kind]);

  // 開いているスレッドを購読（message.delta はここにだけ届く）、見えているスレッド（トースト・既読）
  useEffect(() => {
    subscribeThread(threadId);
    useUi.getState().setVisibleThreadId(threadId);
    return () => {
      subscribeThread(null);
      if (useUi.getState().visibleThreadId === threadId) useUi.getState().setVisibleThreadId(null);
      if (kind === "leader") leaveThread(threadId);
    };
  }, [threadId, kind]);

  const virtual = items.length > VIRTUALIZE_AFTER;
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    scrollMargin: listRef.current?.offsetTop ?? 0,
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (i) => items[i]?.clientId ?? items[i]?.id ?? i,
    paddingStart: 0,
  });

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const el = scrollRef.current;
      if (!el) return;
      if (virtual && items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      });
    },
    [items.length, virtual, virtualizer],
  );

  const tryRead = useCallback(() => {
    if (!atBottom.current) return;
    if (!isPageActive()) return;
    const seq = lastServerSeq(qc, threadId);
    if (seq > 0) markThreadRead(qc, threadId, seq);
  }, [qc, threadId]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottom.current = near;
    setShowPill(!near);
    if (near) tryRead();
    // 上の端に来たら前を取る
    if (el.scrollTop < 200 && q.data?.hasMoreBefore && !loadingOlder.current) {
      loadingOlder.current = true;
      heightBefore.current = el.scrollHeight;
      void loadOlderMessages(qc, threadId).finally(() => {
        loadingOlder.current = false;
      });
    }
  }, [q.data?.hasMoreBefore, qc, threadId, tryRead]);

  // 前を足したら、見ている位置を保つ
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const first = items[0]?.seq ?? null;
    if (el && heightBefore.current !== null && firstSeq.current !== null && first !== null && first < firstSeq.current) {
      el.scrollTop += el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
    }
    firstSeq.current = first;
  }, [items]);

  // 最初に描いたときは一番下へ
  // オフラインで前回のキャッシュも無いときは、取得が止まったまま（paused）なので空の会話として描く（送信待ちの発言は出す。13.5）
  const ready = q.data !== undefined || q.isError || q.fetchStatus === "paused";
  useLayoutEffect(() => {
    if (!ready) return;
    atBottom.current = true;
    scrollToBottom(false);
    const t = setTimeout(() => scrollToBottom(false), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, threadId]);

  // 新しい発言・ストリームの継ぎ足し: 下にいれば追従
  const lastKey = `${items.length}:${items[items.length - 1]?.id ?? ""}:${streamTick}`;
  useEffect(() => {
    if (atBottom.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      if (virtual) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      tryRead();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey]);

  // 大きさが変わっても（カードが開く・画像）下にいれば追従
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // 画面に戻ってきたら既読を見直す
  useEffect(() => {
    const on = () => tryRead();
    window.addEventListener("focus", on);
    document.addEventListener("visibilitychange", on);
    return () => {
      window.removeEventListener("focus", on);
      document.removeEventListener("visibilitychange", on);
    };
  }, [tryRead]);

  const rows = virtual
    ? virtualizer.getVirtualItems().map((v) => {
        const m = items[v.index]!;
        return (
          <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="vrow" style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}>
            <MessageItem m={m} ctx={ctx} grouped={isGrouped(items[v.index - 1], m)} />
          </div>
        );
      })
    : items.map((m, i) => <MessageItem key={m.clientId ?? m.id} m={m} ctx={ctx} grouped={isGrouped(items[i - 1], m)} />);

  return (
    <section className="thread" data-testid={TESTIDS.thread} data-thread-id={threadId} data-kind={kind}>
      <div className="thread__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread__content" ref={contentRef} style={{ paddingBottom: bottomInset }}>
          {header}
          {q.data?.hasMoreBefore && <div className="thread__older" aria-hidden="true"><span className="spinner" /></div>}
          {!ready ? (
            <SkeletonBubbles />
          ) : virtual ? (
            <div role="list" ref={listRef} className="thread__list thread__list--virtual" style={{ height: virtualizer.getTotalSize() }}>
              {rows}
            </div>
          ) : (
            <div role="list" className="thread__list">
              {rows}
            </div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {showPill && ready && (
          <motion.button
            type="button"
            className="latest-pill glass glass--chip"
            data-testid={TESTIDS.latestPill}
            style={{ bottom: bottomInset - 24 }}
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95, transition: { duration: 0.14 } }}
            transition={spring.snappy}
            onClick={() => {
              atBottom.current = true;
              setShowPill(false);
              scrollToBottom(true);
            }}
          >
            <IconChevronDown size={16} />
            <span>{UI_TEXT_V2.conversation.latest}</span>
          </motion.button>
        )}
      </AnimatePresence>
    </section>
  );
}

/** 既読の印などのため、キャッシュから最新の seq を引く（テスト用） */
export function cachedLastSeq(qc: ReturnType<typeof useQueryClient>, threadId: string): number {
  return (qc.getQueryData<{ items: ThreadMessage[] }>(qk.messages(threadId))?.items ?? []).reduce((m, x) => Math.max(m, x.seq), 0);
}
