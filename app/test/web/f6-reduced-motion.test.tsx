// F6 reduced-motion のとき背景アニメーション用のクラスが付かない
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { setMedia } from "./setup.ts";
import { AmbientBackground } from "../../src/web/components/AmbientBackground.tsx";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Motion は "(prefers-reduced-motion)"、CSS は "(prefers-reduced-motion: reduce)" を見る
function setReduced(on: boolean) {
  setMedia("(prefers-reduced-motion)", on);
  setMedia("(prefers-reduced-motion: reduce)", on);
}

describe("F6 reduced-motion", () => {
  it("動きを減らす設定では漂いのクラスを付けない", () => {
    setReduced(true);
    const { container } = render(<AmbientBackground />);
    const root = container.querySelector(".ambient")!;
    expect(root).not.toBeNull();
    expect(root.classList.contains("ambient--drift")).toBe(false);
    expect(container.querySelectorAll(".ambient__glow")).toHaveLength(4);
  });

  it("通常の設定では漂いのクラスが付く", () => {
    setReduced(false);
    const { container } = render(<AmbientBackground />);
    expect(container.querySelector(".ambient")!.classList.contains("ambient--drift")).toBe(true);
  });

  it("CSS 側でも reduced-motion で背景の漂いを止めている", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../src/web/styles/app.css"), "utf8");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.ambient__glow\s*\{\s*animation:\s*none/);
  });
});
