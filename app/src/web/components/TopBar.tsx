// 上部バー: ランナーの点・使用量リング・アバター（メニュー）（7.2・7.5）
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT, type RunnerStatus, type SessionInfo, type UsageToday } from "@baton/shared";
import { api } from "../api/client.ts";
import { clockTime, compactNumber } from "../lib/time.ts";
import { spring } from "../motion/tokens.ts";
import { IconArchive, IconChevronLeft, IconFolder, IconGauge, IconLogout, IconQuestion } from "./Icons.tsx";
import { useUi } from "../state/ui.ts";

export function RunnerDot({ runner }: { runner: RunnerStatus | null }) {
  const online = runner?.online ?? false;
  const prev = useRef(online);
  const [ripple, setRipple] = useState(0);
  useEffect(() => {
    // オンラインになった瞬間に緑のさざ波を 1 回
    if (online && !prev.current) setRipple((n) => n + 1);
    prev.current = online;
  }, [online]);
  const title = runner?.lastHeartbeatAt ? clockTime(runner.lastHeartbeatAt) : undefined;
  return (
    <span
      className="runner-dot"
      data-testid={TESTIDS.runnerDot}
      data-online={online ? "true" : "false"}
      title={title}
      role="img"
      aria-label={title ?? "-"}
    >
      <span className="runner-dot__core" />
      {ripple > 0 && <span key={ripple} className="runner-dot__ripple" />}
    </span>
  );
}

export function UsageRing({ usage }: { usage: UsageToday | undefined }) {
  const used = usage ? usage.tokensIn + usage.tokensOut : 0;
  const limit = usage?.dailyTokenLimit || 1;
  const ratio = Math.min(1, used / limit);
  const r = 8;
  const c = 2 * Math.PI * r;
  const tone = usage?.quotaHitAt ? "var(--accent-danger)" : ratio > 0.8 ? "var(--accent-warning)" : "var(--accent)";
  return (
    <span className="usage-ring" data-testid={TESTIDS.usageRing} title={usage ? `${compactNumber(used)} / ${compactNumber(limit)}` : undefined}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={r} fill="none" stroke="rgba(11,13,18,0.1)" strokeWidth="2.5" />
        <circle
          cx="11"
          cy="11"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          transform="rotate(-90 11 11)"
          style={{ transition: "stroke-dashoffset 600ms var(--ease-out)" }}
        />
      </svg>
    </span>
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

type Props = {
  session: SessionInfo | undefined;
  usage: UsageToday | undefined;
  /** ホーム以外では左に戻るボタンと画面名 */
  back?: { title: string } | null;
};

export function TopBar({ session, usage, back }: Props) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
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

  const used = usage ? usage.tokensIn + usage.tokensOut : null;

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <div className="topbar__left">
          {back ? (
            <Link to="/" className="topbar__back glass glass--chip" aria-label={UI_TEXT.close}>
              <IconChevronLeft size={18} />
            </Link>
          ) : null}
          {back ? <h1 className="topbar__title">{back.title}</h1> : null}
        </div>
        <div className="topbar__right-wrap" ref={menuRef}>
          <div className="topbar__right glass glass--chip">
          <RunnerDot runner={session?.runner ?? null} />
          <UsageRing usage={usage} />
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
          </div>
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
                <Link to="/projects" role="menuitem" className="menu__item" data-testid={TESTIDS.menuProjects} onClick={() => setOpen(false)}>
                  <IconFolder size={18} />
                  <span>{UI_TEXT.menuProjects}</span>
                </Link>
                <Link to="/archive" role="menuitem" className="menu__item" data-testid={TESTIDS.menuArchive} onClick={() => setOpen(false)}>
                  <IconArchive size={18} />
                  <span>{UI_TEXT.menuArchive}</span>
                </Link>
                <div role="menuitem" aria-disabled="true" className="menu__item menu__item--static" data-testid={TESTIDS.menuUsage}>
                  <IconGauge size={18} />
                  <span>{UI_TEXT.menuUsage}</span>
                  <span className="menu__value">{used === null ? "-" : `${compactNumber(used)} / ${compactNumber(usage!.dailyTokenLimit)}`}</span>
                </div>
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
      </div>
    </header>
  );
}
