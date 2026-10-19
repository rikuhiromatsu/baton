// F16 ダークのトークンとコントラスト比（両テーマで 4.5 以上）・テーマの決め方（OS・固定）・ちらつかせない仕組み（13.11・D-92）
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyTheme, readThemePref, resolveTheme, saveThemePref } from "../../src/web/lib/theme.ts";

const root = resolve(import.meta.dirname, "../..");
const tokens = readFileSync(resolve(root, "src/web/styles/tokens.css"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const headers = readFileSync(resolve(root, "public/_headers"), "utf8");

/** CSS のブロックから --name: value を取り出す */
function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
function blockAfter(css: string, selector: string): string {
  const i = css.indexOf(selector);
  expect(i, selector).toBeGreaterThanOrEqual(0);
  const start = css.indexOf("{", i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  return "";
}

type RGBA = { r: number; g: number; b: number; a: number };
function color(v: string): RGBA {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (!m) throw new Error(`色が読めない: ${v}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}
function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a + bottom.a * (1 - top.a);
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}
function luminance(c: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrast(fg: RGBA, bg: RGBA): number {
  const text = over(fg, bg);
  const [l1, l2] = [luminance(text), luminance(bg)].sort((a, b) => b - a);
  return (l1! + 0.05) / (l2! + 0.05);
}

const light = vars(blockAfter(tokens, ":root {"));
const darkFixed = vars(blockAfter(tokens, ':root[data-theme="dark"]'));
const darkAuto = vars(blockAfter(tokens, ':root:not([data-theme="light"])'));

describe("F16 トークン", () => {
  it("ダークの値は 13.11 のとおり（OS 自動と固定で同じ値）", () => {
    expect(darkFixed["--bg-base"]).toBe("#0B0D12");
    expect(darkFixed["--glass-bg"]).toBe("rgba(28, 30, 38, 0.55)");
    expect(darkFixed["--text-primary"]).toBe("#F2F4F8");
    expect(darkFixed["--accent-decision"]).toBe("#BF5AF2");
    expect(darkFixed["--role-coo"]).toBe("#7D7AFF");
    expect(light["--role-coo"]).toBe("#5E5CE6");
    expect(light["--role-leader"]).toBe("#0FA5A0");
    expect(light["--role-member"]).toBe("#E07A1F");
    expect(darkAuto).toEqual(darkFixed);
    // ダークで上書きしない色は無い（ライトで定義した色のトークンはダークにもある）
    for (const k of Object.keys(light).filter((k) => /^--(bg|glass-bg|text-(primary|secondary|tertiary|on-accent)|accent|role|fill|line|surface|scrim|sk|diff)/.test(k))) expect(darkFixed, k).toHaveProperty(k);
  });

  for (const [name, t] of [
    ["ライト", light],
    ["ダーク", darkFixed],
  ] as const) {
    it(`${name}: 主要な文字と背景（ガラスを地に重ねた色）のコントラスト比が 4.5 以上`, () => {
      const base = color(t["--bg-base"]!);
      const tint = color(t["--bg-tint"]!);
      const surfaces = [base, tint, over(color(t["--glass-bg"]!), base), over(color(t["--glass-bg-strong"]!), base), over(color(t["--glass-bg"]!), tint), over(color(t["--glass-fallback-bg"]!), base)];
      for (const bg of surfaces) {
        expect(contrast(color(t["--text-primary"]!), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(t["--text-secondary"]!), bg)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("F16 テーマの決め方", () => {
  it("自動は OS に合わせ、固定はそのまま", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("固定すると data-theme と theme-color（media なし 1 つ）、自動に戻すと外して media 付き 2 つ", () => {
    saveThemePref("dark");
    expect(readThemePref()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    let metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    expect(metas.map((m) => [m.content, m.getAttribute("media")])).toEqual([["#0B0D12", null]]);
    saveThemePref("auto");
    expect(readThemePref()).toBe("auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    expect(metas.map((m) => m.getAttribute("media"))).toEqual(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("index.html: 先頭の同期スクリプトでテーマを読む。CSP（_headers）にそのハッシュがある", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<style>"));
    expect(scripts[0]).toContain("baton.theme");
    const hash = createHash("sha256").update(scripts[0]!).digest("base64");
    expect(headers).toContain(`'sha256-${hash}'`);
    expect(headers).toMatch(/script-src 'self' 'sha256-/);
  });

  it("index.html: インラインの CSS にダークの値を持つ（OS 自動と固定の両方）。theme-color は 2 つ", () => {
    expect(html).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"] {');
    expect(html).toMatch(/--b-bg: #0B0D12/);
    expect(html).toContain('<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)" />');
    expect(html).toContain('<meta name="theme-color" content="#0B0D12" media="(prefers-color-scheme: dark)" />');
  });
});
