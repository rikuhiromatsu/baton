// Web テストの共通準備（happy-dom に無いものを最低限足す）
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

type Listener = (e: { matches: boolean; media: string }) => void;

/** matchMedia を差し替えられるようにする（F6 で reduced-motion を切り替える） */
export const mediaState: Record<string, boolean> = {};
const mediaListeners = new Map<string, Set<Listener>>();

export function setMedia(query: string, matches: boolean): void {
  mediaState[query] = matches;
  for (const l of mediaListeners.get(query) ?? []) l({ matches, media: query });
}

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => {
    const listeners = mediaListeners.get(query) ?? new Set<Listener>();
    mediaListeners.set(query, listeners);
    return {
      get matches() {
        return mediaState[query] ?? false;
      },
      media: query,
      onchange: null,
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
      dispatchEvent: () => false,
    };
  },
});

if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!("IntersectionObserver" in window)) {
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = function () {};
  HTMLElement.prototype.releasePointerCapture = function () {};
}
window.scrollTo = (() => {}) as typeof window.scrollTo;

// happy-dom の Web Animations は cancel で未処理の reject を出すので、Motion には JS のアニメーションを使わせる
for (const proto of [Element.prototype, HTMLElement.prototype] as object[]) {
  if (Object.prototype.hasOwnProperty.call(proto, "animate")) delete (proto as { animate?: unknown }).animate;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});
