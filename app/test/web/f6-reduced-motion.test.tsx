// F6 reduced-motion のとき背景アニメーション用のクラスが付かない。CSS でも止める
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setMedia } from "./setup.ts";
import { AmbientBackground } from "../../src/web/components/AmbientBackground.tsx";

function setReduced(on: boolean) {
  setMedia("(prefers-reduced-motion)", on);
  setMedia("(prefers-reduced-motion: reduce)", on);
}

const styles = (name: string) => readFileSync(resolve(import.meta.dirname, "../../src/web/styles", name), "utf8");

describe("F6 reduced-motion", () => {
  it("動きを減らす設定では漂いのクラスを付けない", () => {
    setReduced(true);
    const { container } = render(<AmbientBackground />);
    const root = container.querySelector(".ambient")!;
    expect(root.classList.contains("ambient--drift")).toBe(false);
    expect(container.querySelectorAll(".ambient__glow")).toHaveLength(4);
  });

  it("通常の設定では漂いのクラスが付く", () => {
    setReduced(false);
    const { container } = render(<AmbientBackground />);
    expect(container.querySelector(".ambient")!.classList.contains("ambient--drift")).toBe(true);
  });

  it("CSS 側でも背景の漂い・入力中の印・組織図の回転・委任の光を止める", () => {
    const css = styles("misc.css");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.ambient__glow\s*\{\s*animation:\s*none/);
    for (const sel of [".typing__dots i", ".org-node--running .org-node__ring", ".org-spark", ".caret"]) expect(block).toContain(sel);
    // app.css が全部の部品を読み込んでいる
    const app = styles("app.css");
    for (const f of ["tokens.css", "base.css", "layout.css", "conversation.css", "cards.css", "detail.css", "org.css", "misc.css"]) expect(app).toContain(f);
  });
});
