// 入力欄（v1 7.4・DESIGN-v2 13.4・13.5）。宛先（→ COO / → リーダー）とプロジェクトのチップ、ターン中は中断。
// index.html の #boot-composer の値・選択範囲・フォーカスを引き継いで置き換える（D-19）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT, UI_TEXT_V2, LIMITS } from "@baton/shared";
import { sendToSession, sendToThread } from "../api/messages.ts";
import { BOOT_SEND_ID, getBootComposer, readBootComposer, removeBootComposer } from "../lib/boot.ts";
import { isApplePlatform, isTouchDevice } from "../lib/env.ts";
import { hhmm } from "../lib/time.ts";
import type { ComposerTarget } from "../lib/target.ts";
import { useDraft } from "../state/draft.ts";
import { useUi } from "../state/ui.ts";
import { spring } from "../motion/tokens.ts";
import { IconArrowUp, IconClock, IconSquare, IconX } from "./Icons.tsx";

const MAX_LINES = 8;
const MAX_CHARS = LIMITS.ceoMessageMaxChars;

let composerEl: HTMLTextAreaElement | null = null;

/** 入力欄にフォーカスする（空白タップ・ショートカットから。pointerup の中で同期的に呼ぶ） */
export function focusComposer(): void {
  const el = composerEl ?? getBootComposer();
  if (!el) return;
  el.focus({ preventScroll: true });
  const end = el.value.length;
  try {
    el.setSelectionRange(end, end);
  } catch {
    // 無視
  }
}

/** 入力欄を出さない画面（ログイン・設定）で、埋め込みの入力欄の文字を下書きへ移す */
export function adoptBootComposerIntoDraft(key = "coo"): void {
  const boot = getBootComposer();
  if (!boot) return;
  const { value } = readBootComposer(boot);
  if (value) useDraft.getState().setText(key, value);
  removeBootComposer();
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export type ComposerProps = {
  target: ComposerTarget;
  /** スレッドのターンが動いている・メンバーが動いている（中断を出す） */
  running?: boolean;
  onInterrupt?: () => void;
  /** 返事待ち（入力欄の上の帯。4.5） */
  awaitingReply?: boolean;
  /** 枠切れの間（9.3）。戻る時刻 */
  quotaBlockedUntil?: number | null;
  onClearContext?: () => void;
};

export function Composer({ target, running = false, onInterrupt, awaitingReply = false, quotaBlockedUntil = null, onClearContext }: ComposerProps) {
  const qc = useQueryClient();
  const key = target.draftKey;
  const text = useDraft((s) => s.texts[key] ?? "");
  const setText = useCallback((v: string) => useDraft.getState().setText(key, v), [key]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sentByPointer = useRef(false);
  const keyRef = useRef(key);
  keyRef.current = key;
  const targetRef = useRef(target);
  targetRef.current = target;
  const [bubble, setBubble] = useState<{ id: string; text: string } | null>(null);
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_CHARS && target.send !== null;
  // 埋め込みの入力欄で打っている間（iOS）は、こちらを隠して二重に見せない
  const [bootActive, setBootActive] = useState(false);
  const showInterrupt = running && trimmed.length === 0 && !!onInterrupt;

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
    const max = lh * MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, []);

  const send = useCallback(async () => {
    const k = keyRef.current;
    const t = targetRef.current;
    const body = useDraft.getState().texts[k] ?? "";
    // 送れないもの（空・長すぎ・宛先なし）は下書きを消さずにそのまま残す
    if (!body.trim() || body.trim().length > MAX_CHARS || !t.send) return;
    const clientId = crypto.randomUUID();
    // 入力欄の泡 → 会話の吹き出し（layoutId）。泡を 1 フレーム描いてから発言を差し込む
    setBubble({ id: clientId, text: body.trim() });
    useDraft.getState().clear(k);
    if (ref.current) ref.current.value = "";
    await nextFrame();
    if (t.send.kind === "thread") {
      sendToThread(qc, t.send.threadId, body, { contextProjectId: t.contextProject?.id ?? null, instructionId: t.send.instructionId }, Date.now(), clientId);
    } else {
      sendToSession(qc, t.send.sessionId, t.send.instructionId, body, Date.now(), clientId);
    }
    setBubble(null);
  }, [qc]);

  // 埋め込みの入力欄を引き継ぐ（D-19）。v1 の守り（iOS のタッチ送信・二重 remove の防止）をそのまま保つ
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    composerEl = el;
    const boot = getBootComposer();
    let cleanup: (() => void) | undefined;
    let adopting = false;
    const adopt = () => {
      // 取り除く途中で blur が起き、もう一度ここに入ることがある（二重に remove すると例外になる）
      if (adopting) return;
      const b = getBootComposer();
      if (!b) return;
      adopting = true;
      const st = readBootComposer(b);
      const k = keyRef.current;
      const cur = useDraft.getState().texts[k] ?? "";
      const merged = st.value || cur;
      if (merged !== cur) useDraft.getState().setText(k, merged);
      el.value = merged;
      cleanup?.();
      removeBootComposer();
      setBootActive(false);
      if (st.focused) {
        el.focus({ preventScroll: true });
        try {
          el.setSelectionRange(Math.min(st.selectionStart, merged.length), Math.min(st.selectionEnd, merged.length));
        } catch {
          // 無視
        }
      }
      resize();
    };
    // 利用者がもう触っている（打った・タップした）ときだけ埋め込みのまま使う。autofocus だけならすぐ引き継ぐ
    const userActive = !!boot && (boot.value !== "" || (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === true);
    if (boot && document.activeElement === boot && isTouchDevice() && userActive) {
      // iOS は focus() でキーボードを出し直せないので、打っている間は埋め込みのまま使い、離れたら引き継ぐ
      const bootSend = document.getElementById(BOOT_SEND_ID);
      // 送信ボタンを押している間に入力欄のフォーカスが外れても、ここでは引き継がない。
      // 引き継ぐと送信ボタンごと消えて click が届かない（送信は onSend が引き継ぎと一緒に行う）
      let pressingSend = false;
      const onPressSend = (e: Event) => {
        pressingSend = true;
        e.preventDefault();
      };
      const onBlur = () => {
        if (pressingSend) return;
        adopt();
      };
      let sent = false;
      const onSend = (e: Event) => {
        e.preventDefault();
        if (e.type === "pointerup" && (e as PointerEvent).pointerType === "mouse") return;
        if (sent) return;
        sent = true;
        pressingSend = false;
        const b = getBootComposer();
        if (b) useDraft.getState().setText(keyRef.current, b.value);
        adopt();
        void send();
      };
      setBootActive(true);
      // 埋め込みの入力欄は COO 宛て。リーダーのスレッドなど宛先が違うときは表示を合わせる（13.5）
      boot.setAttribute("aria-label", targetRef.current.aria);
      boot.setAttribute("data-testid", targetRef.current.inputTestId);
      const metaRole = document.querySelector("#boot-composer-wrap .b-meta b");
      if (metaRole && targetRef.current.role !== "coo") metaRole.textContent = targetRef.current.role === "leader" ? UI_TEXT_V2.roles.leader : UI_TEXT_V2.composer.followupAria;
      boot.addEventListener("blur", onBlur);
      bootSend?.addEventListener("pointerdown", onPressSend);
      bootSend?.addEventListener("mousedown", onPressSend);
      bootSend?.addEventListener("pointerup", onSend);
      bootSend?.addEventListener("click", onSend);
      cleanup = () => {
        boot.removeEventListener("blur", onBlur);
        bootSend?.removeEventListener("pointerdown", onPressSend);
        bootSend?.removeEventListener("mousedown", onPressSend);
        bootSend?.removeEventListener("pointerup", onSend);
        bootSend?.removeEventListener("click", onSend);
      };
    } else if (boot) {
      adopt();
    } else if (!isTouchDevice() && (document.activeElement === document.body || document.activeElement === null)) {
      // デスクトップは読み込み直後に自動フォーカス（7.4）
      el.focus({ preventScroll: true });
    }
    return () => {
      cleanup?.();
      if (composerEl === el) composerEl = null;
    };
  }, [resize, send]);

  useEffect(() => {
    resize();
  }, [text, resize]);

  // デスクトップ: どこにいても / か ⌘K で入力欄へ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useUi.getState().onboardingOpen) return; // 案内を開いている間はショートカットを効かせない
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        focusComposer();
        return;
      }
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        focusComposer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // iOS: キーボードが出たら入力欄をキーボードの真上に保つ（spring は使わず即時）
  useEffect(() => {
    const vv = window.visualViewport;
    const wrap = wrapRef.current;
    if (!vv || !wrap) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      wrap.style.transform = offset > 1 ? `translate3d(0, ${-offset}px, 0)` : "";
      wrap.dataset.keyboard = offset > 1 ? "open" : "closed";
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (useUi.getState().onboardingOpen) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const blocked = quotaBlockedUntil !== null && quotaBlockedUntil > Date.now();

  return (
    <div
      className="composer-wrap"
      ref={wrapRef}
      data-role={target.role}
      style={bootActive ? { visibility: "hidden" } : undefined}
      aria-hidden={bootActive || undefined}
    >
      <div className="composer-col">
        <AnimatePresence initial={false}>
          {(awaitingReply || blocked) && (
            <motion.div
              key={blocked ? "quota" : "awaiting"}
              className={`composer-band glass glass--chip composer-band--${blocked ? "quota" : "awaiting"}`}
              data-testid={blocked ? undefined : TESTIDS.awaitingReply}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, transition: { duration: 0.14 } }}
              transition={spring.snappy}
            >
              {blocked ? (
                <>
                  <IconClock size={14} />
                  <span>{UI_TEXT_V2.transcript.quotaHit}</span>
                  <span className="sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="num">{hhmm(quotaBlockedUntil!)}</span>
                  <span>{UI_TEXT_V2.quota.resetsAt}</span>
                </>
              ) : (
                <>
                  <span className="composer-band__dot" aria-hidden="true" />
                  <span>{UI_TEXT_V2.sidebar.awaitingReply}</span>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {bubble && (
          <motion.div layoutId={`msg-${bubble.id}`} className="composer-bubble" transition={spring.gentle}>
            <span className="composer-bubble__text">{bubble.text}</span>
          </motion.div>
        )}
        <div className="composer glass glass--bar">
          <div className="composer__meta">
            <span className={`thread-target thread-target--${target.role}`} data-testid={TESTIDS.threadTarget}>
              <span className="thread-target__arrow" aria-hidden="true">
                {UI_TEXT_V2.conversation.arrow}
              </span>
              {target.role === "member" ? (
                <span>{UI_TEXT_V2.composer.followupAria}</span>
              ) : (
                <>
                  <span className="thread-target__role">{target.role === "coo" ? UI_TEXT_V2.roles.coo : UI_TEXT_V2.roles.leader}</span>
                  {target.role === "leader" && target.name && (
                    <>
                      <span className="thread-target__sep" aria-hidden="true">
                        ·
                      </span>
                      <span className="thread-target__name">{target.name}</span>
                    </>
                  )}
                </>
              )}
            </span>
            <AnimatePresence initial={false}>
              {target.contextProject && (
                <motion.span
                  key={target.contextProject.id}
                  className="context-chip"
                  data-testid={TESTIDS.contextChip}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.12 } }}
                  transition={spring.pop}
                >
                  <span className="context-chip__name">{target.contextProject.name}</span>
                  <span>{UI_TEXT_V2.conversation.about}</span>
                  <button
                    type="button"
                    className="context-chip__clear"
                    data-testid={TESTIDS.contextChipClear}
                    aria-label={UI_TEXT_V2.composer.clearContextAria}
                    onClick={onClearContext}
                  >
                    <IconX size={12} />
                  </button>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <div className="composer__row">
            <textarea
              ref={ref}
              className="composer__input"
              data-testid={bootActive ? undefined : target.inputTestId}
              aria-label={target.aria}
              rows={1}
              value={text}
              maxLength={MAX_CHARS}
              enterKeyHint="enter"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              aria-keyshortcuts={isApplePlatform() ? "Meta+Enter" : "Control+Enter"}
            />
            <AnimatePresence initial={false} mode="popLayout">
              {showInterrupt ? (
                <motion.button
                  key="stop"
                  type="button"
                  className="composer__send composer__send--stop"
                  data-testid={TESTIDS.interruptButton}
                  aria-label={UI_TEXT_V2.composer.interrupt}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  whileTap={{ scale: 0.9 }}
                  transition={spring.pop}
                  onClick={onInterrupt}
                >
                  <IconSquare size={18} />
                  <span className="composer__stop-ring" aria-hidden="true" />
                </motion.button>
              ) : (
                <motion.button
                  key="send"
                  type="button"
                  className="composer__send"
                  data-testid={bootActive ? undefined : target.sendTestId}
                  aria-label={UI_TEXT.sendAria}
                  disabled={!canSend}
                  data-ready={canSend ? "true" : "false"}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  whileTap={{ scale: 0.9 }}
                  transition={spring.pop}
                  onPointerDown={(e) => e.preventDefault()}
                  onPointerUp={(e) => {
                    // pointerdown の preventDefault（キーボードを閉じないため）で、WebKit はタッチの click を出さない。
                    // タッチは指を離した時点で送り、続く click（出る環境もある）は無視する
                    if (e.pointerType === "mouse") return;
                    sentByPointer.current = true;
                    void send();
                  }}
                  onClick={() => {
                    if (sentByPointer.current) {
                      sentByPointer.current = false;
                      return;
                    }
                    void send();
                  }}
                >
                  <IconArrowUp size={20} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
