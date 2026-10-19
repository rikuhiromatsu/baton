// 指示入力（7.4・7.5）。index.html の #boot-composer の値・選択範囲・フォーカスを引き継いで置き換える
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT } from "@baton/shared";
import { submitInstruction } from "../api/actions.ts";
import { BOOT_SEND_ID, getBootComposer, readBootComposer, removeBootComposer } from "../lib/boot.ts";
import { isApplePlatform, isTouchDevice } from "../lib/env.ts";
import { useDraft } from "../state/draft.ts";
import { useUi } from "../state/ui.ts";
import { spring } from "../motion/tokens.ts";
import { IconArrowUp } from "./Icons.tsx";

const MAX_LINES = 8;
/** CreateInstructionInput の上限（trim 後 8000 文字） */
const MAX_CHARS = 8000;

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

/** 未ログインの画面で、埋め込みの入力欄の文字を下書きへ移す */
export function adoptBootComposerIntoDraft(): void {
  const boot = getBootComposer();
  if (!boot) return;
  const { value } = readBootComposer(boot);
  if (value) useDraft.getState().setText(value);
  removeBootComposer();
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function Composer() {
  const qc = useQueryClient();
  const text = useDraft((s) => s.text);
  const setText = useDraft((s) => s.setText);
  const bubble = useUi((s) => s.bubble);
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canSend = text.trim().length > 0 && text.trim().length <= MAX_CHARS;

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
    const body = useDraft.getState().text;
    // 送れないもの（空・長すぎ）は下書きを消さずにそのまま残す
    if (!body.trim() || body.trim().length > MAX_CHARS) return;
    const clientId = crypto.randomUUID();
    // 入力欄の泡 → 一覧のカード（layoutId）。泡を 1 フレーム描いてからカードを差し込む
    useUi.getState().setBubble({ clientId, text: body.trim() });
    useDraft.getState().clear();
    await nextFrame();
    submitInstruction(qc, body, Date.now(), clientId);
    useUi.getState().setBubble(null);
  }, [qc]);

  // 埋め込みの入力欄を引き継ぐ（D-19）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    composerEl = el;
    const boot = getBootComposer();
    let cleanup: (() => void) | undefined;
    const adopt = () => {
      const b = getBootComposer();
      if (!b) return;
      const st = readBootComposer(b);
      const merged = st.value || useDraft.getState().text;
      if (merged !== useDraft.getState().text) setText(merged);
      el.value = merged;
      removeBootComposer();
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
    if (boot && document.activeElement === boot && isTouchDevice()) {
      // iOS は focus() でキーボードを出し直せないので、打っている間は埋め込みのまま使い、離れたら引き継ぐ
      const bootSend = document.getElementById(BOOT_SEND_ID);
      const onBlur = () => adopt();
      const onSend = (e: Event) => {
        e.preventDefault();
        const b = getBootComposer();
        if (b) setText(b.value);
        adopt();
        void send();
      };
      boot.addEventListener("blur", onBlur, { once: true });
      bootSend?.addEventListener("click", onSend, { once: true });
      cleanup = () => {
        boot.removeEventListener("blur", onBlur);
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
  }, [resize, send, setText]);

  useEffect(() => {
    resize();
  }, [text, resize]);

  // デスクトップ: どこにいても / か ⌘K で入力欄へ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer-wrap" ref={wrapRef}>
      {bubble && (
        <motion.div layoutId={`card-${bubble.clientId}`} className="composer-bubble glass glass--card" transition={spring.gentle}>
          <span className="composer-bubble__text">{bubble.text}</span>
        </motion.div>
      )}
      <div className="composer glass glass--bar">
        <textarea
          ref={ref}
          className="composer__input"
          data-testid={TESTIDS.composerInput}
          aria-label={UI_TEXT.composerAria}
          rows={1}
          value={text}
          maxLength={MAX_CHARS}
          enterKeyHint="enter"
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-keyshortcuts={isApplePlatform() ? "Meta+Enter" : "Control+Enter"}
        />
        <motion.button
          type="button"
          className="composer__send"
          data-testid={TESTIDS.composerSend}
          aria-label={UI_TEXT.sendAria}
          disabled={!canSend}
          data-ready={canSend ? "true" : "false"}
          whileTap={{ scale: 0.9 }}
          transition={spring.pop}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => void send()}
        >
          <IconArrowUp size={20} />
        </motion.button>
      </div>
    </div>
  );
}
