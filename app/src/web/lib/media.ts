// 画面の幅の段（13.3・13.4・D-72）。≥1280 は常時、1024〜1279 はレール、<1024 はドロワーとシート
import { useSyncExternalStore } from "react";

export type Breakpoint = "wide" | "mid" | "narrow";

export const WIDE_QUERY = "(min-width: 1280px)";
export const MID_QUERY = "(min-width: 1024px)";

function current(): Breakpoint {
  if (typeof window === "undefined" || !window.matchMedia) return "narrow";
  if (window.matchMedia(WIDE_QUERY).matches) return "wide";
  if (window.matchMedia(MID_QUERY).matches) return "mid";
  return "narrow";
}

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const qs = [window.matchMedia(WIDE_QUERY), window.matchMedia(MID_QUERY)];
  for (const q of qs) q.addEventListener?.("change", cb);
  return () => {
    for (const q of qs) q.removeEventListener?.("change", cb);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current, () => "narrow");
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = typeof window === "undefined" ? null : window.matchMedia?.(query);
      q?.addEventListener?.("change", cb);
      return () => q?.removeEventListener?.("change", cb);
    },
    () => (typeof window === "undefined" ? false : (window.matchMedia?.(query).matches ?? false)),
    () => false,
  );
}

export function usePrefersDark(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)");
}
