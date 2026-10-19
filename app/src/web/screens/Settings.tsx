// 設定（/settings。13.10）: 外観・通知・秘書（bot トークン）・役割（見るだけ）
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BOT_SCOPES,
  MEMBER_PROFILE_LABELS,
  TESTIDS,
  UI_TEXT_V2,
  type BotScope,
  type BotTokenView,
  type MemberProfile,
  type ThemeValue,
} from "@baton/shared";
import { api } from "../api/client.ts";
import { qk } from "../api/keys.ts";
import { useBotAudit, useBotTokens, useProfiles, usePushSubscriptions, useSession } from "../api/queries.ts";
import { IconAuto, IconBell, IconCheck, IconCopy, IconKey, IconMoon, IconSun } from "../components/Icons.tsx";
import { ScreenHeader } from "../components/ScreenHeader.tsx";
import { getPushDriver, subscribeThisDevice } from "../lib/push.ts";
import { readThemePref, saveThemePref } from "../lib/theme.ts";
import { clockTime, relativeTime } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
import { spring } from "../motion/tokens.ts";
import { toastId, useToasts } from "../state/toasts.ts";

const SCOPE_LABEL: Record<BotScope, string> = {
  read: UI_TEXT_V2.settings.scopeRead,
  message: UI_TEXT_V2.settings.scopeMessage,
  propose: UI_TEXT_V2.settings.scopePropose,
};

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.section className="settings-section glass glass--card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle}>
      <h2 className="settings-section__title">
        <span className="settings-section__icon" aria-hidden="true">
          {icon}
        </span>
        <span>{title}</span>
      </h2>
      {children}
    </motion.section>
  );
}

function Appearance() {
  const [pref, setPref] = useState<ThemeValue>(readThemePref);
  const options: { v: ThemeValue; label: string; icon: React.ReactNode }[] = [
    { v: "auto", label: UI_TEXT_V2.settings.auto, icon: <IconAuto size={15} /> },
    { v: "light", label: UI_TEXT_V2.settings.light, icon: <IconSun size={15} /> },
    { v: "dark", label: UI_TEXT_V2.settings.dark, icon: <IconMoon size={15} /> },
  ];
  return (
    <div className="segmented segmented--wide" role="radiogroup" aria-label={UI_TEXT_V2.settings.appearance}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={pref === o.v}
          className="segmented__item"
          data-testid={TESTIDS.themeOption}
          data-value={o.v}
          onClick={() => {
            setPref(o.v);
            saveThemePref(o.v);
          }}
        >
          {pref === o.v && <motion.span layoutId="theme-thumb" className="segmented__thumb" transition={spring.snappy} />}
          <span className="segmented__label">
            {o.icon}
            {o.label}
          </span>
        </button>
      ))}
    </div>
  );
}

/** この端末の通知のスイッチ（許可は利用者の操作のときだけ求める。10.4）。初回の案内の最後でも使う */
export function PushControl({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const session = useSession();
  const subs = usePushSubscriptions(!compact);
  const support = getPushDriver().support();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void getPushDriver()
      .current()
      .then((s) => alive && setOn(s !== null && getPushDriver().permission() === "granted"))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (support === "ios-needs-install") {
    return (
      <p className="push-hint" data-testid={TESTIDS.pushIosHint}>
        {UI_TEXT_V2.settings.iosHint}
      </p>
    );
  }
  if (support === "unsupported") return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!on) {
        const key = session.data?.vapidPublicKey;
        if (!key) throw new Error("vapid");
        const input = await subscribeThisDevice(key);
        if (!input) throw new Error("denied");
        await api.createPushSubscription(input);
        setOn(true);
      } else {
        const cur = await getPushDriver().current();
        await getPushDriver().unsubscribe();
        const host = cur?.endpoint ? new URL(cur.endpoint).host : null;
        const mine = (subs.data?.items ?? []).find((x) => x.host === host);
        if (mine) await api.deletePushSubscription(mine.id);
        setOn(false);
      }
      void qc.invalidateQueries({ queryKey: qk.pushSubscriptions });
    } catch {
      useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" role="switch" aria-checked={on} className={`switch-row ${compact ? "switch-row--compact" : ""}`} data-testid={TESTIDS.pushToggle} disabled={busy} onClick={() => void toggle()}>
      <span className="switch-row__label">{compact ? UI_TEXT_V2.settings.enablePush : UI_TEXT_V2.settings.thisDevice}</span>
      <span className="switch" data-on={on ? "true" : "false"} aria-hidden="true">
        <motion.span className="switch__knob" layout transition={spring.pop} />
      </span>
    </button>
  );
}

function Devices() {
  const qc = useQueryClient();
  const subs = usePushSubscriptions();
  const now = useNow();
  const items = subs.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="device-list">
      <AnimatePresence initial={false}>
        {items.map((d) => (
          <motion.li key={d.id} className="device" data-testid={TESTIDS.pushDevice} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
            <span className="device__name">{d.deviceLabel || d.host}</span>
            <span className="device__meta">{d.lastSuccessAt ? relativeTime(d.lastSuccessAt, now) : d.host}</span>
            <button
              type="button"
              className="ghost-button ghost-button--quiet"
              onClick={() => {
                void api
                  .deletePushSubscription(d.id)
                  .then(() => qc.invalidateQueries({ queryKey: qk.pushSubscriptions }))
                  .catch(() => useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() }));
              }}
            >
              {UI_TEXT_V2.settings.remove}
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function AuditList({ tokenId }: { tokenId: string }) {
  const q = useBotAudit(tokenId);
  const now = useNow();
  return (
    <motion.ul className="audit-list" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth}>
      {(q.data?.items ?? []).map((a) => (
        <li key={a.id} className={`audit-item audit-item--${a.outcome}`} data-testid={TESTIDS.botAuditItem}>
          <code className="audit-item__action">{a.action}</code>
          <span className="audit-item__summary">{a.summary}</span>
          <span className="audit-item__time" title={clockTime(a.createdAt)}>
            {relativeTime(a.createdAt, now)}
          </span>
        </li>
      ))}
    </motion.ul>
  );
}

function TokenItem({ t }: { t: BotTokenView }) {
  const qc = useQueryClient();
  const now = useNow();
  const [audit, setAudit] = useState(false);
  const revoked = t.revokedAt !== null;
  return (
    <motion.li layout className={`token ${revoked ? "token--revoked" : ""}`} data-testid={TESTIDS.botTokenItem} data-revoked={revoked ? "true" : "false"} transition={spring.smooth}>
      <div className="token__row">
        <span className="token__icon" aria-hidden="true">
          <IconKey size={15} />
        </span>
        <span className="token__name">{t.name}</span>
        <span className="token__scopes">
          {t.scopes.map((s) => (
            <span key={s} className="pill">
              {SCOPE_LABEL[s]}
            </span>
          ))}
        </span>
        <span className="token__used">{t.lastUsedAt ? relativeTime(t.lastUsedAt, now) : "-"}</span>
        <button type="button" className="ghost-button ghost-button--quiet" aria-expanded={audit} onClick={() => setAudit((v) => !v)}>
          {UI_TEXT_V2.settings.audit}
        </button>
        {!revoked && (
          <button
            type="button"
            className="ghost-button ghost-button--danger"
            data-testid={TESTIDS.botTokenRevoke}
            onClick={() => {
              void api
                .revokeBotToken(t.id)
                .then(() => qc.invalidateQueries({ queryKey: qk.botTokens }))
                .catch(() => useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() }));
            }}
          >
            {UI_TEXT_V2.settings.revoke}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>{audit && <AuditList tokenId={t.id} />}</AnimatePresence>
    </motion.li>
  );
}

function Secretary() {
  const qc = useQueryClient();
  const tokens = useBotTokens();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<BotScope[]>([...BOT_SCOPES]);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const issue = async () => {
    if (busy) return;
    if (!name.trim()) {
      nameRef.current?.focus();
      return;
    }
    if (scopes.length === 0) return;
    setBusy(true);
    try {
      const res = await api.createBotToken({ name: name.trim(), scopes });
      setIssued(res.token);
      setCopied(false);
      setName("");
      void qc.invalidateQueries({ queryKey: qk.botTokens });
    } catch {
      useToasts.getState().show({ id: toastId(), kind: "updateFailed", createdAt: Date.now() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="token-form">
        <label className="field-label">
          <span>{UI_TEXT_V2.settings.name}</span>
          <input ref={nameRef} className="field field--line" type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void issue()} />
        </label>
        <div className="token-form__scopes">
          {BOT_SCOPES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...new Set([...cur, s])] : cur.filter((x) => x !== s)))} />
              <span className="check__box" aria-hidden="true">
                <IconCheck size={12} />
              </span>
              <span>{SCOPE_LABEL[s]}</span>
            </label>
          ))}
        </div>
        <motion.button type="button" className="primary-button" data-testid={TESTIDS.botTokenCreate} disabled={busy} whileTap={{ scale: 0.96 }} transition={spring.pop} onClick={() => void issue()}>
          {UI_TEXT_V2.settings.issue}
        </motion.button>
      </div>
      <AnimatePresence>
        {issued && (
          <motion.div className="token-issued" initial={{ opacity: 0, scale: 0.97, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={spring.gentle}>
            <input className="field field--mono" readOnly value={issued} data-testid={TESTIDS.botTokenValue} aria-label={UI_TEXT_V2.settings.secretary} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(issued)
                  .then(() => setCopied(true))
                  .catch(() => {});
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              <span>{UI_TEXT_V2.conversation.copy}</span>
            </button>
            <p className="token-issued__note">{UI_TEXT_V2.settings.shownOnce}</p>
          </motion.div>
        )}
      </AnimatePresence>
      <ul className="token-list">
        {(tokens.data?.items ?? []).map((t) => (
          <TokenItem key={t.id} t={t} />
        ))}
      </ul>
    </>
  );
}

function Roles() {
  const profiles = useProfiles();
  return (
    <ul className="role-list">
      {(profiles.data?.items ?? []).map((p) => (
        <li key={p.id} className="role-item">
          <span className={`role-dot role-dot--${p.role}`} aria-hidden="true" />
          <span className="role-item__name">{p.id in MEMBER_PROFILE_LABELS ? MEMBER_PROFILE_LABELS[p.id as MemberProfile] : p.role === "coo" ? UI_TEXT_V2.roles.coo : UI_TEXT_V2.roles.leader}</span>
          <code className="role-item__model">{p.model}</code>
          <span className="role-item__skills">
            {p.skills.map((s) => (
              <code key={s} className="chip-code">
                {s}
              </code>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SettingsScreen() {
  return (
    <div className="screen screen--settings">
      <ScreenHeader cards={false} title={<span className="thread-title">{UI_TEXT_V2.settings.title}</span>} />
      <div className="settings" data-testid={TESTIDS.settings}>
        <Section title={UI_TEXT_V2.settings.appearance} icon={<IconSun size={16} />}>
          <Appearance />
        </Section>
        <Section title={UI_TEXT_V2.settings.notifications} icon={<IconBell size={16} />}>
          <PushControl />
          <Devices />
        </Section>
        <Section title={UI_TEXT_V2.settings.secretary} icon={<IconKey size={16} />}>
          <Secretary />
        </Section>
        <Section title={UI_TEXT_V2.settings.roles} icon={<IconAuto size={16} />}>
          <Roles />
        </Section>
      </div>
    </div>
  );
}
