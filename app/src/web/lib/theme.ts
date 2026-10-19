// テーマ（13.11・D-92）。既定は OS に合わせて自動、設定で固定。index.html のインラインスクリプトと同じ決め方
import { THEME_STORAGE_KEY, THEME_VALUES, type ThemeValue } from "@baton/shared";

export const THEME_COLORS = { light: "#FFFFFF", dark: "#0B0D12" } as const;

export function isThemeValue(v: unknown): v is ThemeValue {
  return typeof v === "string" && (THEME_VALUES as readonly string[]).includes(v);
}

export function readThemePref(): ThemeValue {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** 実際に描く色（純粋関数。F16） */
export function resolveTheme(pref: ThemeValue, systemDark: boolean): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return systemDark ? "dark" : "light";
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
}

/**
 * html の data-theme と theme-color を合わせる。自動のときは data-theme を外し、theme-color を media 付きの 2 つに戻す。
 * 固定のときは data-theme を付け、theme-color を media なしの 1 つにする（13.11）
 */
export function applyTheme(pref: ThemeValue, doc: Document = document): void {
  const root = doc.documentElement;
  if (pref === "auto") delete root.dataset.theme;
  else root.dataset.theme = pref;
  const metas = [...doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  for (const m of metas) m.remove();
  const add = (content: string, media?: string) => {
    const m = doc.createElement("meta");
    m.name = "theme-color";
    m.content = content;
    if (media) m.setAttribute("media", media);
    doc.head.appendChild(m);
  };
  if (pref === "auto") {
    add(THEME_COLORS.light, "(prefers-color-scheme: light)");
    add(THEME_COLORS.dark, "(prefers-color-scheme: dark)");
  } else {
    add(THEME_COLORS[pref]);
  }
}

export function saveThemePref(pref: ThemeValue): void {
  try {
    if (pref === "auto") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // 保存できなくても、この画面の間は効かせる
  }
  applyTheme(pref);
}
