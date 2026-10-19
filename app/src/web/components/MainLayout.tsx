// 画面の骨組み（13.2〜13.4・13.13）。サイドパネル｜会話（または詳細・組織図・設定）｜指示カードの列、下に入力欄。
// モバイルは COO の会話の上に、リーダーのスレッド（右から）・詳細（下から）・ほかの画面（右から）を重ねる
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2, type ListThreadsOutput } from "@baton/shared";
import { interruptSession, interruptThread, totalUnread } from "../api/messages.ts";
import { qk } from "../api/keys.ts";
import { useMessages, useQuota, useSession, useSidebar, useThreads } from "../api/queries.ts";
import { dismissBootSkeleton } from "../lib/boot.ts";
import { useBreakpoint } from "../lib/media.ts";
import { setAppBadge } from "../lib/push.ts";
import { composerTarget, parseRoute, type ScreenRoute } from "../lib/target.ts";
import { hhmm } from "../lib/time.ts";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";
import { DetailScreen } from "../screens/Detail.tsx";
import { OrgScreen } from "../screens/Org.tsx";
import { SettingsScreen } from "../screens/Settings.tsx";
import { ArchiveScreen } from "../screens/Archive.tsx";
import { CooScreen, LeaderScreen } from "../screens/Threads.tsx";
import { CardsColumn, CardsSheet } from "./CardsPanel.tsx";
import { Composer, adoptBootComposerIntoDraft } from "./Composer.tsx";
import { ActionMenu, MessageMenu, SendBackSheet } from "./Overlays.tsx";
import { Sheet } from "./Sheet.tsx";
import { Sidebar, SidebarDrawer } from "./Sidebar.tsx";

const EDGE_PX = 16;

function routeKey(r: ScreenRoute): string {
  switch (r.kind) {
    case "coo":
      return "coo";
    case "leader":
      return `leader:${r.projectId}`;
    case "detail":
      return `detail:${r.instructionId}`;
    default:
      return r.kind;
  }
}

/** 未読数を document.title とアプリのバッジに（4.8） */
function useUnreadTitle() {
  const threads = useThreads();
  const qc = useQueryClient();
  const n = threads.data ? totalUnread(qc) : 0;
  useEffect(() => {
    document.title = n > 0 ? `(${n}) Baton` : "Baton";
    setAppBadge(n);
  }, [n, threads.data]);
}

function QuotaSheet() {
  const open = useUi((s) => s.quotaSheetOpen);
  const session = useSession();
  const quota = useQuota(session.data !== undefined);
  const q = quota.data;
  const close = useCallback(() => useUi.getState().setQuotaSheetOpen(false), []);
  const row = (label: string, u: number | null, resetsAt: number | null) => (
    <div className="quota-row">
      <div className="quota-row__head">
        <span>{label}</span>
        <span className="num">{u === null ? "-" : `${Math.round(u * 100)}%`}</span>
      </div>
      <div className="quota-row__bar" aria-hidden="true">
        <motion.span className="quota-row__fill" data-tone={u !== null && u >= 0.8 ? "warn" : "ok"} initial={{ scaleX: 0 }} animate={{ scaleX: Math.min(1, u ?? 0) }} transition={spring.smooth} />
      </div>
      {resetsAt && (
        <div className="quota-row__reset">
          <span className="num">{hhmm(resetsAt)}</span>
          <span>{UI_TEXT_V2.quota.resetsAt}</span>
        </div>
      )}
    </div>
  );
  return (
    <Sheet open={open} onClose={close} testId={TESTIDS.quotaSheet} label={UI_TEXT_V2.quota.fiveHour} title={<span className="sheet-title">{UI_TEXT_V2.quota.fiveHour}</span>}>
      {q && (
        <div className="quota-sheet">
          {row(UI_TEXT_V2.quota.fiveHour, q.fiveHour.utilization, q.fiveHour.resetsAt)}
          {row(UI_TEXT_V2.quota.sevenDay, q.sevenDay.utilization, q.sevenDay.resetsAt)}
          <div className="quota-sheet__cost num">${q.estimatedCostTodayUsd.toFixed(2)}</div>
        </div>
      )}
    </Sheet>
  );
}

export function MainLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as { s?: string } });
  const route = parseRoute(pathname);
  const bp = useBreakpoint();
  const narrow = bp === "narrow";
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const detailTarget = useUi((s) => s.detailTarget);
  const chipCleared = useUi((s) => s.chipCleared);
  const sidebar = useSidebar();
  const threads = useThreads();
  const session = useSession();
  const quota = useQuota(session.data !== undefined);
  const lastBase = useRef<string>("/");
  const lastCooProject = useRef<string | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useUnreadTitle();

  // 会話の場所を覚える（詳細を閉じたとき・モバイルで下に敷く会話）
  useEffect(() => {
    if (route.kind === "coo") lastCooProject.current = route.projectId;
    if (route.kind !== "detail") lastBase.current = pathname;
  }, [pathname, route]);

  // 起動直後のスケルトン（index.html）を外す
  // COO の会話は発言がそろうまで全画面スケルトンのまま（13.12。E3）。取得に失敗したとき・オフラインで止まったときは外す
  const cooMessages = useMessages(qc, route.kind === "coo" ? COO_THREAD_ID : null);
  const ready =
    route.kind === "settings" ||
    route.kind === "org" ||
    route.kind === "archive" ||
    threads.isError ||
    threads.fetchStatus === "paused" ||
    (threads.data !== undefined && (route.kind !== "coo" || cooMessages.data !== undefined || cooMessages.isError || cooMessages.fetchStatus === "paused"));
  useEffect(() => {
    if (ready) dismissBootSkeleton();
  }, [ready]);

  // 選んでいたプロジェクトは localStorage にも（D-70）
  useEffect(() => {
    try {
      if (route.kind === "coo" && route.projectId) localStorage.setItem("baton.lastProject", route.projectId);
    } catch {
      // 無視
    }
    if (route.kind === "coo" && route.projectId && chipCleared && chipCleared !== route.projectId) useUi.getState().setChipCleared(null);
  }, [route, chipCleared]);

  // ⌘\ でサイドパネルをレールに
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (bp === "mid") useUi.getState().setDrawerOpen(!useUi.getState().drawerOpen);
        else useUi.getState().setSidebarCollapsed(!useUi.getState().sidebarCollapsed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bp]);

  // 中間幅: レールのボタンで重ねて開く（drawerOpen を使う）。画面を移ったら閉じる
  const midOpen = useUi((st) => st.drawerOpen) && bp === "mid";
  useEffect(() => {
    if (bp === "mid") useUi.getState().setDrawerOpen(false);
  }, [pathname, bp]);

  // モバイル: 画面の左端から右へのスワイプ（リーダーのスレッドでは COO に戻る。ほかはドロワー）。
  // タッチは途中でブラウザがスクロールに切り替えると pointercancel が来るので、touch のイベントでも見る
  useEffect(() => {
    if (!narrow) return;
    // 指の追跡は pointer と touch で別々に持つ（どちらかが届けば動く）
    const starts: Record<"pointer" | "touch", { x: number; y: number; id: number } | null> = { pointer: null, touch: null };
    let fired = false;
    const begin = (kind: "pointer" | "touch", x: number, y: number, id: number) => {
      if (kind === "pointer" || !starts.pointer) fired = false;
      starts[kind] = x <= EDGE_PX ? { x, y, id } : null;
    };
    const track = (kind: "pointer" | "touch", x: number, y: number, id: number) => {
      const st = starts[kind];
      if (!st || st.id !== id || fired) return;
      const dx = x - st.x;
      const dy = y - st.y;
      if (Math.abs(dy) > 40 && Math.abs(dy) > dx) starts[kind] = null;
      else if (dx > 56) {
        fired = true;
        starts.pointer = null;
        starts.touch = null;
        const r = parseRoute(window.location.pathname);
        if (r.kind === "leader") void navigate({ to: "/" });
        else useUi.getState().setDrawerOpen(true);
      }
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") begin("pointer", e.clientX, e.clientY, e.pointerId);
    };
    const move = (e: PointerEvent) => track("pointer", e.clientX, e.clientY, e.pointerId);
    const up = (e: PointerEvent) => {
      if (starts.pointer?.id === e.pointerId) starts.pointer = null;
    };
    const tStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t && e.touches.length === 1) begin("touch", t.clientX, t.clientY, t.identifier);
    };
    const tMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) track("touch", t.clientX, t.clientY, t.identifier);
    };
    const tEnd = () => {
      starts.touch = null;
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", down, opts);
    window.addEventListener("pointermove", move, opts);
    window.addEventListener("pointerup", up, opts);
    window.addEventListener("touchstart", tStart, opts);
    window.addEventListener("touchmove", tMove, opts);
    window.addEventListener("touchend", tEnd, opts);
    window.addEventListener("touchcancel", tEnd, opts);
    return () => {
      window.removeEventListener("pointerdown", down, opts);
      window.removeEventListener("pointermove", move, opts);
      window.removeEventListener("pointerup", up, opts);
      window.removeEventListener("touchstart", tStart, opts);
      window.removeEventListener("touchmove", tMove, opts);
      window.removeEventListener("touchend", tEnd, opts);
      window.removeEventListener("touchcancel", tEnd, opts);
    };
  }, [narrow, navigate]);

  // 入力欄の宛先
  const sideItems = sidebar.data?.items;
  const target = useMemo(
    () =>
      composerTarget(route, {
        leaderThreadIdOf: (pid) => sideItems?.find((i) => i.project.id === pid)?.leaderThread.id ?? null,
        projectNameOf: (pid) => sideItems?.find((i) => i.project.id === pid)?.project.name ?? null,
        detailTarget,
        chipCleared,
      }),
    [route, sideItems, detailTarget, chipCleared],
  );
  useEffect(() => {
    if (!target) adoptBootComposerIntoDraft();
  }, [target]);

  const threadList = (threads.data as ListThreadsOutput | undefined)?.items ?? [];
  const sendThreadId = target?.send?.kind === "thread" ? target.send.threadId : null;
  const sendThread = sendThreadId ? threadList.find((t) => t.id === sendThreadId) : undefined;
  const memberRunning = target?.send?.kind === "session" && detailTarget?.role === "member" ? detailTarget.running : false;
  const running = target?.role === "member" ? memberRunning : sendThread?.status === "running";
  const onInterrupt = () => {
    if (target?.send?.kind === "session") void interruptSession(qc, target.send.sessionId, target.send.instructionId);
    else if (sendThreadId) void interruptThread(qc, sendThreadId);
  };
  const blockedUntil = quota.data?.status === "rejected" ? (quota.data.blockedUntil ?? quota.data.fiveHour.resetsAt ?? null) : null;

  const closeDetail = useCallback(() => {
    void navigate({ to: lastBase.current.startsWith("/i/") ? "/" : lastBase.current });
  }, [navigate]);

  const projectForCards = route.kind === "coo" || route.kind === "leader" ? route.projectId : null;

  const screenFor = (r: ScreenRoute, asSheet: boolean) => {
    switch (r.kind) {
      case "coo":
        return <CooScreen projectId={r.projectId} />;
      case "leader":
        return <LeaderScreen projectId={r.projectId} />;
      case "detail":
        return <DetailScreen id={r.instructionId} sessionParam={search.s} onClose={closeDetail} sheet={asSheet} />;
      case "org":
        return <OrgScreen />;
      case "settings":
        return <SettingsScreen />;
      case "archive":
        return <ArchiveScreen />;
      default:
        return null;
    }
  };

  const key = routeKey(route);
  const composer = target && (
    <Composer
      key={target.draftKey}
      target={target}
      running={running}
      onInterrupt={onInterrupt}
      awaitingReply={target.role !== "member" && (sendThread?.awaitingReply ?? false) && !running}
      quotaBlockedUntil={blockedUntil}
      onClearContext={() => {
        if (target.contextProject) useUi.getState().setChipCleared(target.contextProject.id);
        if (route.kind === "coo" && route.projectId) void navigate({ to: "/" });
      }}
    />
  );

  if (narrow) {
    const overlay = route.kind !== "coo" ? route : null;
    const baseVisible = !overlay || settledKey !== key;
    const kind = overlay?.kind;
    const fromBottom = kind === "detail";
    return (
      <div className="layout layout--narrow" data-route={route.kind}>
        <main className="center center--narrow">
          {baseVisible && (
            <div className="layer layer--base" inert={overlay ? true : undefined}>
              <CooScreen projectId={route.kind === "coo" ? route.projectId : lastCooProject.current} />
            </div>
          )}
          <AnimatePresence initial={false} onExitComplete={() => setSettledKey(null)}>
            {overlay && (
              <motion.div
                key={key}
                className={`layer layer--overlay layer--${kind}`}
                initial={fromBottom ? { y: "100%" } : { x: "100%" }}
                animate={fromBottom ? { y: 0 } : { x: 0 }}
                exit={fromBottom ? { y: "100%", transition: { duration: 0.26, ease: [0.65, 0, 0.35, 1] } } : { x: "100%", transition: { duration: 0.26, ease: [0.65, 0, 0.35, 1] } }}
                transition={spring.smooth}
                onAnimationComplete={() => setSettledKey(key)}
                ref={(el) => {
                  // 最初から重ねて開いたとき（アニメーションなし）も、下の会話を外す
                  if (el && settledKey !== key && !el.dataset.mounted) {
                    el.dataset.mounted = "1";
                    requestAnimationFrame(() => {
                      if (getComputedStyle(el).transform === "none") setSettledKey(key);
                    });
                  }
                }}
              >
                {screenFor(overlay, true)}
              </motion.div>
            )}
          </AnimatePresence>
          {composer}
        </main>
        <SidebarDrawer />
        <CardsSheet projectId={projectForCards} />
        <QuotaSheet />
        <ActionMenu />
        <MessageMenu />
        <SendBackSheet />
      </div>
    );
  }

  const showCards = route.kind === "coo" || route.kind === "leader" || (route.kind === "detail" && bp === "mid");
  const sidebarMode = bp === "wide" && !collapsed ? "fixed" : "rail";
  return (
    <div className="layout layout--desk" data-bp={bp} data-sidebar={sidebarMode} data-cards={showCards ? "true" : "false"} data-route={route.kind}>
      <div className="layout__sidebar">
        <Sidebar mode={sidebarMode} />
        <AnimatePresence>
          {bp === "mid" && midOpen && (
            <motion.div className="layout__sidebar-overlay" initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={spring.smooth}>
              <Sidebar mode="fixed" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <main className="center center--desk">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={route.kind === "coo" ? "coo" : key}
            className="layer layer--desk"
            initial={{ opacity: 0, x: route.kind === "leader" ? 28 : 0, y: route.kind === "detail" ? 14 : 0 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.14 } }}
            transition={spring.smooth}
          >
            {screenFor(route, false)}
          </motion.div>
        </AnimatePresence>
        {composer}
      </main>
      {showCards && <CardsColumn projectId={projectForCards} />}
      <QuotaSheet />
      <ActionMenu />
      <MessageMenu />
      <SendBackSheet />
    </div>
  );
}

export { COO_THREAD_ID, qk };
