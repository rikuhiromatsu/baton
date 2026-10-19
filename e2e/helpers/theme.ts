// ダークモード（DESIGN-v2 13.11）の検査の道具。ページの中で色を読み、WCAG のコントラスト比を計算する
import type { Page } from "@playwright/test";
import { THEME_STORAGE_KEY } from "@baton/shared";

export { THEME_STORAGE_KEY };

export type ContrastSample = { selector: string; text: string; color: string; background: string; ratio: number };

/**
 * root の中の「主要な文字」（色が --text-primary と同じもの）を最大 limit 個選び、
 * 実際に重なっている背景（祖先の background-color を半透明も含めて合成し、一番下は html・body の地）とのコントラスト比を返す。
 * 背景画像（ぼかしの光など）は無視する（ガラスの不透明時の色で比べる。13.11 の「契約の検査」と同じ考え）
 */
export async function primaryTextContrast(page: Page, rootSelector: string, limit = 40): Promise<ContrastSample[]> {
  return page.evaluate(
    ({ rootSelector, limit }) => {
      type RGBA = [number, number, number, number];
      const parse = (c: string): RGBA | null => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return null;
        const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts.length > 3 ? parts[3]! : 1];
      };
      // color-mix などで計算値が rgb() 以外になる場合に備え、canvas で正規化する
      const ctx = document.createElement("canvas").getContext("2d")!;
      const norm = (c: string): RGBA | null => {
        const direct = parse(c);
        if (direct) return direct;
        ctx.fillStyle = "#000";
        ctx.fillStyle = c;
        return parse(ctx.fillStyle) ?? (/^#/.test(ctx.fillStyle) ? hex(ctx.fillStyle) : null);
      };
      const hex = (h: string): RGBA => {
        const n = parseInt(h.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
      };
      const over = (top: RGBA, bottom: RGBA): RGBA => {
        const a = top[3] + bottom[3] * (1 - top[3]);
        if (a === 0) return [0, 0, 0, 0];
        const ch = (i: number) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a;
        return [ch(0), ch(1), ch(2), a];
      };
      const lum = (c: RGBA) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const ratio = (a: RGBA, b: RGBA) => {
        const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
        return (l1 + 0.05) / (l2 + 0.05);
      };
      // --text-primary の実際の色
      const probe = document.createElement("span");
      probe.style.color = "var(--text-primary)";
      document.body.appendChild(probe);
      const primary = norm(getComputedStyle(probe).color);
      probe.remove();
      // 一番下の地: html → body の背景（無ければ --bg-base）
      const baseProbe = document.createElement("div");
      baseProbe.style.background = "var(--bg-base, #fff)";
      document.body.appendChild(baseProbe);
      let ground = norm(getComputedStyle(baseProbe).backgroundColor) ?? [255, 255, 255, 1];
      baseProbe.remove();
      for (const el of [document.documentElement, document.body]) {
        const bg = norm(getComputedStyle(el).backgroundColor);
        if (bg && bg[3] > 0) ground = over(bg, ground);
      }
      ground = [ground[0], ground[1], ground[2], 1];
      const backgroundOf = (el: Element): RGBA => {
        const chain: Element[] = [];
        for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) chain.unshift(e);
        let acc = ground;
        for (const e of chain) {
          const cs = getComputedStyle(e);
          const bg = norm(cs.backgroundColor);
          const opacity = Number(cs.opacity || "1");
          if (bg && bg[3] > 0) acc = over([bg[0], bg[1], bg[2], bg[3] * opacity], acc);
        }
        return acc;
      };
      const root = document.querySelector(rootSelector) ?? document.body;
      const out: { selector: string; text: string; color: string; background: string; ratio: number }[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const seen = new Set<Element>();
      while (out.length < limit && walker.nextNode()) {
        const node = walker.currentNode as Text;
        const el = node.parentElement;
        if (!el || seen.has(el) || !node.data.trim()) continue;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        const color = norm(cs.color);
        if (!color || !primary) continue;
        const same = Math.abs(color[0] - primary[0]) + Math.abs(color[1] - primary[1]) + Math.abs(color[2] - primary[2]) < 6 && Math.abs(color[3] - primary[3]) < 0.05;
        if (!same) continue;
        const bg = backgroundOf(el);
        const fg = over(color, bg);
        out.push({
          selector: `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[data-testid=${el.getAttribute("data-testid")}]` : ""}`,
          text: node.data.trim().slice(0, 30),
          color: cs.color,
          background: `rgb(${bg.slice(0, 3).map((v) => Math.round(v)).join(", ")})`,
          ratio: Math.round(ratio(fg, bg) * 100) / 100,
        });
      }
      return out;
    },
    { rootSelector, limit },
  );
}

/** html の計算済みの color-scheme（"dark" / "light"） */
export async function htmlColorScheme(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
}

/** 地の明るさ（0 = 黒、1 = 白）。body → html の背景色を見る（スケルトンの段階でも測れる） */
export async function groundLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pick = (el: Element) => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
      if (!m) return null;
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      if ((p[3] ?? 1) === 0) return null;
      return p.slice(0, 3);
    };
    const rgb = pick(document.body) ?? pick(document.documentElement) ?? [255, 255, 255];
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
  });
}
