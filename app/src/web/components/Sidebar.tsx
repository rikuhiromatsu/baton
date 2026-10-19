// サイドパネル（13.3・D-72）。一番上に COO、承認待ち、進行中のプロジェクト、その他、組織・アーカイブ・設定。
// ≥1280px は常時（⌘\ でレール）、1024〜1279px はレール（押すと重なる）、<1024px はドロワー
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2, displayGroup, type ProjectSidebarItem, type ThreadSummary } from "@baton/shared";
import { useActiveList, useSidebar, useThreads } from "../api/queries.ts";
import { parseRoute } from "../lib/target.ts";
import { spring } from "../motion/tokens.ts";
import { useStreams } from "../state/streams.ts";
import { useUi } from "../state/ui.ts";
import { BatonMark, IconArchive, IconBranch, IconChat, IconChevronDown, IconHand, IconOrg, IconSettings, IconSidebar } from "./Icons.tsx";

export type SidebarMode = "fixed" | "rail" | "drawer";

function Typing() {
  return (
    <span className="mini-typing" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function CooRow({ thread, active, rail, onNavigate }: { thread: ThreadSummary | undefined; active: boolean; rail: boolean; onNavigate: () => void }) {
  const running = thread?.status === "running";
  const preview = useStreams((s) => {
    const live = Object.values(s.byId).find((x) => x.threadId === COO_THREAD_ID);
    return live?.text ? live.text.replace(/\s+/g, " ").slice(-80) : null;
  });
  return (
    <Link to="/" className="side-row side-row--coo" data-testid={TESTIDS.sidebarCoo} data-active={active ? "true" : "false"} aria-label={UI_TEXT_V2.sidebar.coo} onClick={onNavigate}>
      {active && <motion.span layoutId={rail ? "side-active-rail" : "side-active"} className="side-row__active" transition={spring.snappy} />}
      <span className="side-avatar side-avatar--coo" aria-hidden="true">
        <span>C</span>
        {running && <span className="side-avatar__pulse" />}
      </span>
      {!rail && (
        <span className="side-row__main">
          <span className="side-row__title">
            <span className="side-row__name">{UI_TEXT_V2.sidebar.coo}</span>
            {thread?.awaitingReply && <span className="pill pill--awaiting">{UI_TEXT_V2.sidebar.awaitingReply}</span>}
          </span>
          <span className="side-row__sub">{running ? (preview ?? <Typing />) : (thread?.lastMessage?.preview ?? "")}</span>
        </span>
      )}
      {(thread?.unread ?? 0) > 0 && (
        <motion.span key={thread!.unread} className="badge" data-testid={TESTIDS.sidebarUnread} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={spring.pop}>
          {thread!.unread}
        </motion.span>
      )}
    </Link>
  );
}

function ProjectRow({ item, active, rail, onNavigate }: { item: ProjectSidebarItem; active: boolean; rail: boolean; onNavigate: () => void }) {
  const p = item.project;
  const c = item.counts;
  const tone = c.needsDecision > 0 ? "needs_decision" : c.review > 0 ? "review" : c.running > 0 ? "running" : c.failed > 0 ? "failed" : "idle";
  const lt = item.leaderThread;
  const chips: { kind: "needs_decision" | "review" | "running"; n: number }[] = [
    { kind: "needs_decision" as const, n: c.needsDecision },
    { kind: "review" as const, n: c.review },
    { kind: "running" as const, n: c.running },
  ].filter((x) => x.n > 0);
  return (
    <motion.li layout="position" transition={spring.smooth} className="side-item-wrap">
      <Link
        to="/p/$projectId"
        params={{ projectId: p.id }}
        className="side-row side-row--project"
        data-testid={TESTIDS.sidebarItem}
        data-project-id={p.id}
        data-active={active ? "true" : "false"}
        aria-label={p.name}
        onClick={onNavigate}
      >
        {active && <motion.span layoutId={rail ? "side-active-rail" : "side-active"} className="side-row__active" transition={spring.snappy} />}
        {rail ? (
          <span className={`side-avatar side-avatar--project side-avatar--${tone}`} aria-hidden="true">
            <span>{p.name.charAt(0)}</span>
          </span>
        ) : (
          <span className={`status-dot status-dot--${tone === "idle" ? "queued" : tone}`} aria-hidden="true" />
        )}
        {!rail && (
          <span className="side-row__main">
            <span className="side-row__title">
              <span className="side-row__name">{p.name}</span>
              {p.workspaceKind === "repo" && (
                <span className="side-row__branch" aria-hidden="true">
                  <IconBranch size={13} />
                </span>
              )}
              {lt.talkingWithCeo && <span className="pill pill--talking">{UI_TEXT_V2.sidebar.talking}</span>}
            </span>
            {item.activity ? (
              <motion.span key={item.activity} className="side-row__sub side-row__sub--activity" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle}>
                {item.activity}
              </motion.span>
            ) : null}
          </span>
        )}
        {!rail && chips.length > 0 && (
          <span className="side-row__chips">
            {chips.map((ch) => (
              <motion.span key={ch.kind} className={`count-chip count-chip--${ch.kind}`} data-testid={TESTIDS.sidebarCount} data-kind={ch.kind} initial={{ scale: 0.7 }} animate={{ scale: 1 }} transition={spring.pop}>
                {ch.n}
              </motion.span>
            ))}
          </span>
        )}
      </Link>
      {!rail && (
        <Link
          to="/p/$projectId/leader"
          params={{ projectId: p.id }}
          className="side-leader"
          data-testid={TESTIDS.sidebarLeaderLink}
          aria-label={UI_TEXT_V2.conversation.talkToLeader}
          onClick={onNavigate}
        >
          <IconChat size={16} />
          {lt.unread > 0 && <span className="side-leader__dot" aria-hidden="true" />}
        </Link>
      )}
    </motion.li>
  );
}

export function SidebarContent({ mode, onNavigate }: { mode: SidebarMode; onNavigate?: () => void }) {
  const rail = mode === "rail";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const route = parseRoute(pathname);
  const threads = useThreads();
  const sidebar = useSidebar();
  const list = useActiveList();
  const [othersOpen, setOthersOpen] = useState(false);
  const coo = threads.data?.items.find((t) => t.id === COO_THREAD_ID);
  const items = sidebar.data?.items ?? [];
  const active = items.filter((i) => i.inProgress);
  const others = items.filter((i) => !i.inProgress);
  const approvals = sidebar.data?.approvals ?? 0;
  const approvalTarget = list.data?.items.find((i) => i.openDecisionCount > 0 && displayGroup(i) === "needs_decision");
  const nav = () => onNavigate?.();
  const activeProjectId = route.kind === "coo" || route.kind === "leader" ? route.projectId : null;

  return (
    <div className={`sidebar-content sidebar-content--${mode}`}>
      <div className="sidebar__brand">
        <BatonMark size={rail ? 28 : 26} />
        {!rail && <span className="sidebar__brand-name">Baton</span>}
        {mode !== "drawer" && (
          <button
            type="button"
            className="icon-button sidebar__collapse"
            data-testid={TESTIDS.sidebarToggle}
            aria-label={UI_TEXT_V2.sidebar.drawerAria}
            aria-keyshortcuts="Meta+Backslash"
            onClick={() => useUi.getState().setSidebarCollapsed(!useUi.getState().sidebarCollapsed)}
          >
            <IconSidebar size={18} />
          </button>
        )}
      </div>
      <nav className="sidebar__scroll" aria-label={UI_TEXT_V2.sidebar.drawerAria}>
        <CooRow thread={coo} active={route.kind === "coo" && route.projectId === null} rail={rail} onNavigate={nav} />
        <AnimatePresence initial={false}>
          {approvals > 0 && (
            <motion.div key="approvals" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
              <Link
                to={approvalTarget ? "/i/$id" : "/"}
                params={approvalTarget ? { id: approvalTarget.id } : {}}
                className="side-row side-row--approvals"
                data-testid={TESTIDS.sidebarApprovals}
                aria-label={UI_TEXT_V2.sidebar.approvals}
                onClick={nav}
              >
                <span className="side-avatar side-avatar--approvals" aria-hidden="true">
                  <IconHand size={16} />
                </span>
                {!rail && <span className="side-row__name">{UI_TEXT_V2.sidebar.approvals}</span>}
                <span className="badge badge--decision">{approvals}</span>
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
        {!rail && active.length > 0 && <h2 className="sidebar__label">{UI_TEXT_V2.sidebar.drawerAria}</h2>}
        <ul className="sidebar__list">
          {active.map((it) => (
            <ProjectRow key={it.project.id} item={it} active={activeProjectId === it.project.id} rail={rail} onNavigate={nav} />
          ))}
        </ul>
        {others.length > 0 && !rail && (
          <div className="sidebar__others">
            <button type="button" className="sidebar__label sidebar__label--toggle" aria-expanded={othersOpen} onClick={() => setOthersOpen((v) => !v)}>
              <span>{UI_TEXT_V2.sidebar.other}</span>
              <motion.span animate={{ rotate: othersOpen ? 0 : -90 }} transition={spring.snappy} className="sidebar__chev">
                <IconChevronDown size={14} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {othersOpen && (
                <motion.ul className="sidebar__list" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
                  {others.map((it) => (
                    <ProjectRow key={it.project.id} item={it} active={activeProjectId === it.project.id} rail={rail} onNavigate={nav} />
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        )}
      </nav>
      <div className="sidebar__foot">
        <Link to="/org" className="side-link" data-active={route.kind === "org" ? "true" : "false"} aria-label={UI_TEXT_V2.sidebar.org} onClick={nav}>
          <IconOrg size={18} />
          {!rail && <span>{UI_TEXT_V2.sidebar.org}</span>}
        </Link>
        <Link to="/archive" className="side-link" data-active={route.kind === "archive" ? "true" : "false"} aria-label={UI_TEXT_V2.sidebar.archive} onClick={nav}>
          <IconArchive size={18} />
          {!rail && <span>{UI_TEXT_V2.sidebar.archive}</span>}
        </Link>
        <Link to="/settings" className="side-link" data-active={route.kind === "settings" ? "true" : "false"} aria-label={UI_TEXT_V2.sidebar.settings} onClick={nav}>
          <IconSettings size={18} />
          {!rail && <span>{UI_TEXT_V2.sidebar.settings}</span>}
        </Link>
      </div>
    </div>
  );
}

/** デスクトップ・中間幅のサイドパネル（幅は CSS の変数で動かす） */
export function Sidebar({ mode }: { mode: "fixed" | "rail" }) {
  return (
    <aside className={`sidebar sidebar--${mode} glass glass--panel`} data-testid={TESTIDS.sidebar} data-mode={mode}>
      <SidebarContent mode={mode} />
    </aside>
  );
}

/** モバイルのドロワー（左からスライド。左端スワイプ・上部バーのボタンで開く） */
export function SidebarDrawer() {
  const open = useUi((s) => s.drawerOpen);
  const close = () => useUi.getState().setDrawerOpen(false);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="drawer" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 1, transition: { duration: 0.26 } }}>
          <motion.div className="drawer__scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} aria-hidden="true" />
          <motion.aside
            className="drawer__panel glass glass--sheet"
            data-testid={TESTIDS.sidebarDrawer}
            role="dialog"
            aria-modal="true"
            aria-label={UI_TEXT_V2.sidebar.drawerAria}
            initial={{ x: "-104%" }}
            animate={{ x: 0 }}
            exit={{ x: "-104%" }}
            transition={spring.smooth}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.6, right: 0 }}
            onDragEnd={(_, info) => {
              if (info.offset.x < -80 || info.velocity.x < -500) close();
            }}
          >
            <SidebarContent mode="drawer" onNavigate={close} />
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
