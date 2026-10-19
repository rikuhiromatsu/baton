// index.html に埋め込んだ入力欄とスケルトンの引き継ぎ（設計書 7.4・7.9・D-19）
import { BOOT_COMPOSER_ID, BOOT_SKELETON_ID } from "@baton/shared";

export const BOOT_COMPOSER_WRAP_ID = "boot-composer-wrap";
export const BOOT_SEND_ID = "boot-send";

export type BootComposerState = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  focused: boolean;
};

export function getBootComposer(): HTMLTextAreaElement | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(BOOT_COMPOSER_ID);
  return el instanceof HTMLTextAreaElement ? el : null;
}

export function readBootComposer(el: HTMLTextAreaElement): BootComposerState {
  return {
    value: el.value,
    selectionStart: el.selectionStart ?? el.value.length,
    selectionEnd: el.selectionEnd ?? el.value.length,
    focused: document.activeElement === el,
  };
}

export function removeBootComposer(): void {
  const el = document.getElementById(BOOT_COMPOSER_WRAP_ID) ?? getBootComposer();
  if (!el?.isConnected) return;
  try {
    el.remove();
  } catch {
    // blur の中で既に外されていた
  }
}

/**
 * 埋め込みのスケルトンを消す。100ms 未満で消える場合はそのまま（チラつき防止）、
 * それ以降は 220ms のクロスフェード（7.9）
 */
export function dismissBootSkeleton(opts: { immediate?: boolean } = {}): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(BOOT_SKELETON_ID);
  if (!el || el.dataset.leaving === "1") return;
  const early = typeof performance !== "undefined" && performance.now() < 100;
  if (opts.immediate || early) {
    el.remove();
    return;
  }
  el.dataset.leaving = "1";
  el.style.transition = "opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  // testid を外して、消えかけのものを E2E が拾わないようにする
  el.removeAttribute("data-testid");
  setTimeout(() => el.remove(), 240);
}
