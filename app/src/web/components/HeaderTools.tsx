// 上部の道具: ランナーの点・枠のリング・アバター（メニュー）（v1 7.2・DESIGN-v2 9.3・13.12）
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { COO_THREAD_ID, TESTIDS, UI_TEXT, UI_TEXT_V2, type QuotaStatus, type RunnerStatus, type SessionInfo, type SidebarOutput } from "@baton/shared";
import { api } from "../api/client.ts";
import { qk } from "../api/keys.ts";
import { resetThread } from "../api/messages.ts";
import { clockTime, hhmm } from "../lib/time.ts";
import { spring } from "../motion/tokens.ts";
import { useUi } from "../state/ui.ts";
import { IconArchive, IconGauge, IconLogout, IconOrg, IconQuestion, IconRefresh, IconSettings } from "./Icons.tsx";

/** 長押し（タッチ）と、マウスを載せたとき（デスクトップ）に小さな吹き出しを出す */
function useHoldPopover(): { open: boolean; bind: Record<string, (e: React.PointerEvent) => void> } {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 2600);
    return () => clearTimeout(t);
  }, [open]);
  return {
    open,
    bind: {
      onPointerDown: (e) => {
        if (e.pointerType === "mouse") return;
        timer.current = setTimeout(() => setOpen(true), 450);
      },
      onPointerUp: () => void (timer.current && clearTimeout(timer.current)),
      onPointerCancel: () => void (timer.current && clearTimeout(timer.current)),
      onPointerEnter: (e) => {
        if (e.pointerType === "mouse") setOpen(true);
      },
      onPointerLeave: (e) => {
        if (e.pointerType === "mouse") setOpen(false);
      },
    },
  };
}

function Popover({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.span
          className="popover glass glass--chip"
          role="tooltip"
          initial={{ opacity: 0, y: -4, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={spring.snappy}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function RunnerDot({ runner }: { runner: RunnerStatus | null }) {
  const online = runner?.online ?? false;
  const auth = runner?.claudeAuth ?? "unknown";
  const authBad = online && auth !== "ok" && auth !== "unknown";
  const prev = useRef(online);
  const [ripple, setRipple] = useState(0);
  const pop = useHoldPopover();
  useEffect(() => {
    // オンラインになった瞬間に緑のさざ波を 1 回
    if (online && !prev.current) setRipple((n) => n + 1);
    prev.current = online;
  }, [online]);
  return (
    <span
      className="runner-dot"
      data-testid={TESTIDS.runnerDot}
      data-online={online ? "true" : "false"}
      data-auth={auth}
      data-tone={!online ? "off" : authBad ? "warn" : "ok"}
      role="img"
      aria-label={runner?.lastHeartbeatAt ? clockTime(runner.lastHeartbeatAt) : "-"}
      {...pop.bind}
    >
      <span className="runner-dot__core" />
      {ripple > 0 && <span key={ripple} className="runner-dot__ripple" />}
      <Popover open={pop.open && authBad}>{UI_TEXT_V2.runner.notLoggedIn}</Popover>
    </span>
  );
}

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}

/** 5 時間枠（内・太）と週の枠（外・細）のリング（9.3） */
export function QuotaRing({ quota, onOpen }: { quota: QuotaStatus | undefined; onOpen?: () => void }) {
  const five = quota?.fiveHour.utilization ?? null;
  const week = quota?.sevenDay.utilization ?? null;
  const rejected = quota?.status === "rejected";
  const tone = (v: number | null) => (rejected ? "var(--accent-danger)" : v !== null && v >= 0.8 ? "var(--accent-warning)" : "var(--accent)");
  const inner = { r: 6.5, w: 3 };
  const outer = { r: 10, w: 1.6 };
  const c = (r: number) => 2 * Math.PI * r;
  const pop = useHoldPopover();
  const resetsAt = rejected ? (quota?.blockedUntil ?? quota?.fiveHour.resetsAt ?? null) : (quota?.fiveHour.resetsAt ?? null);
  return (
    <button
      type="button"
      className="usage-ring"
      data-testid={TESTIDS.usageRing}
      data-utilization={five ?? ""}
      data-weekly={week ?? ""}
      data-status={quota?.status ?? "unknown"}
      aria-label={`${pct(five)} ${pct(week)}`}
      onClick={onOpen}
      {...pop.bind}
    >
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="13" cy="13" r={outer.r} fill="none" stroke="var(--track)" strokeWidth={outer.w} />
        <circle
          cx="13"
          cy="13"
          r={outer.r}
          fill="none"
          stroke={tone(week)}
          strokeOpacity={0.7}
          strokeWidth={outer.w}
          strokeLinecap="round"
          strokeDasharray={c(outer.r)}
          strokeDashoffset={c(outer.r) * (1 - Math.min(1, week ?? 0))}
          transform="rotate(-90 13 13)"
          style={{ transition: "stroke-dashoffset 700ms var(--ease-out), stroke 300ms" }}
        />
        <circle cx="13" cy="13" r={inner.r} fill="none" stroke="var(--track)" strokeWidth={inner.w} />
        <circle
          cx="13"
          cy="13"
          r={inner.r}
          fill="none"
          stroke={tone(five)}
          strokeWidth={inner.w}
          strokeLinecap="round"
          strokeDasharray={c(inner.r)}
          strokeDashoffset={c(inner.r) * (1 - Math.min(1, five ?? 0))}
          transform="rotate(-90 13 13)"
          style={{ transition: "stroke-dashoffset 700ms var(--ease-out), stroke 300ms" }}
        />
        {rejected && <path d="M13 9.5V13l2 1.4" stroke="var(--accent-danger)" strokeWidth="1.4" strokeLinecap="round" fill="none" />}
      </svg>
      <Popover open={pop.open}>
        <span>{UI_TEXT_V2.quota.fiveHour}</span>
        <span className="num">{pct(five)}</span>
        {resetsAt && (
          <>
            <span className="sep" aria-hidden="true">
              ·
            </span>
            <span className="num">{hhmm(resetsAt)}</span>
            <span>{UI_TEXT_V2.quota.resetsAt}</span>
          </>
        )}
      </Popover>
    </button>
  );
}

function Avatar({ user }: { user: SessionInfo["user"] | null }) {
  if (!user) return <span className="avatar avatar--empty" />;
  if (user.pictureUrl) return <img className="avatar" src={user.pictureUrl} alt="" referrerPolicy="no-referrer" />;
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
  return (
    <span className="avatar avatar--initial" aria-hidden="true">
      {initial}
    </span>
  );
}

export function AvatarMenu({ session }: { session: SessionInfo | undefined }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const logout = async () => {
    setOpen(false);
    try {
      await api.logout();
    } catch {
      // 失敗してもログイン画面へ
    }
    qc.clear();
    void navigate({ to: "/login" });
  };

  return (
    <div className="avatar-menu" ref={ref}>
      <button
        type="button"
        className="topbar__avatar"
        data-testid={TESTIDS.menuButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={session?.user.name ?? session?.user.email ?? "menu"}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar user={session?.user ?? null} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="menu glass glass--sheet"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={spring.snappy}
            style={{ transformOrigin: "top right" }}
          >
            <Link to="/org" role="menuitem" className="menu__item" data-testid={TESTIDS.menuOrg} onClick={() => setOpen(false)}>
              <IconOrg size={18} />
              <span>{UI_TEXT.menuOrg}</span>
            </Link>
            <Link to="/archive" role="menuitem" className="menu__item" data-testid={TESTIDS.menuArchive} onClick={() => setOpen(false)}>
              <IconArchive size={18} />
              <span>{UI_TEXT.menuArchive}</span>
            </Link>
            <Link to="/settings" role="menuitem" className="menu__item" data-testid={TESTIDS.menuSettings} onClick={() => setOpen(false)}>
              <IconSettings size={18} />
              <span>{UI_TEXT.menuSettings}</span>
            </Link>
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              data-testid={TESTIDS.menuUsage}
              onClick={() => {
                setOpen(false);
                useUi.getState().setQuotaSheetOpen(true);
              }}
            >
              <IconGauge size={18} />
              <span>{UI_TEXT.menuUsage}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              data-testid={TESTIDS.menuNewTopic}
              onClick={() => {
                setOpen(false);
                const m = pathname.match(/^\/p\/([^/]+)\/leader$/);
                const leader = m ? qc.getQueryData<SidebarOutput>(qk.sidebar)?.items.find((i) => i.project.id === decodeURIComponent(m[1]!))?.leaderThread.id : null;
                void resetThread(qc, leader ?? COO_THREAD_ID);
              }}
            >
              <IconRefresh size={18} />
              <span>{UI_TEXT.menuNewTopic}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              data-testid={TESTIDS.menuGuide}
              onClick={() => {
                setOpen(false);
                useUi.getState().setOnboardingOpen(true);
              }}
            >
              <IconQuestion size={18} />
              <span>{UI_TEXT.menuGuide}</span>
            </button>
            <div className="menu__sep" />
            <button type="button" role="menuitem" className="menu__item" data-testid={TESTIDS.menuLogout} onClick={() => void logout()}>
              <IconLogout size={18} />
              <span>{UI_TEXT.menuLogout}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function HeaderTools({ session, quota }: { session: SessionInfo | undefined; quota: QuotaStatus | undefined }) {
  return (
    <div className="header-tools glass glass--chip">
      <RunnerDot runner={session?.runner ?? null} />
      <QuotaRing quota={quota} onOpen={() => useUi.getState().setQuotaSheetOpen(true)} />
      <AvatarMenu session={session} />
    </div>
  );
}
