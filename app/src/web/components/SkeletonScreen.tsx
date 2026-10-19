// 全画面スケルトン（v1 7.9・DESIGN-v2 13.12）。≥ 1280px はサイドパネルの行 5 本・吹き出し 4 つ・カード 3 枚、モバイルは吹き出し 4 つ。
// 入力欄はスケルトンにしない。光沢は transform で流す
import { useEffect, useState } from "react";
import { TESTIDS, UI_TEXT } from "@baton/shared";

const RELOAD_AFTER_MS = 10_000;

function ReloadAfterWait() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), RELOAD_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  if (!late) return null;
  return (
    <button type="button" className="skeleton__reload glass glass--chip" data-testid={TESTIDS.skeletonReload} onClick={() => location.reload()}>
      {UI_TEXT.reload}
    </button>
  );
}

/** 会話の吹き出し 4 つ（左右交互） */
export function SkeletonBubbles() {
  return (
    <div className="sk-bubbles" aria-busy="true">
      <div className="sk sk--bubble sk--left" style={{ width: "58%" }} />
      <div className="sk sk--bubble sk--right" style={{ width: "42%" }} />
      <div className="sk sk--bubble sk--left sk--tall" style={{ width: "70%" }} />
      <div className="sk sk--bubble sk--right" style={{ width: "36%" }} />
    </div>
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="sk-cards" aria-busy="true">
      <div className="sk sk--label" />
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk sk--card" />
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="sk-rows" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk sk--row" style={{ width: `${88 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}

/** 画面全体（初回の会話・組織図・設定・詳細） */
export function SkeletonScreen({ variant = "thread" }: { variant?: "thread" | "detail" | "list" | "org" }) {
  return (
    <div className={`skeleton skeleton--${variant}`} data-testid={TESTIDS.skeletonScreen} aria-busy="true">
      <ReloadAfterWait />
      {variant === "thread" && <SkeletonBubbles />}
      {variant === "list" && <SkeletonCards count={5} />}
      {variant === "detail" && (
        <>
          <div className="sk sk--title" />
          <div className="sk-tabs">
            {[0, 1, 2].map((i) => (
              <div key={i} className="sk sk--tab" />
            ))}
          </div>
          <SkeletonRows count={6} />
        </>
      )}
      {variant === "org" && (
        <div className="sk-org">
          <div className="sk sk--node" />
          <div className="sk sk--node" />
          <div className="sk-org__row">
            {[0, 1, 2].map((i) => (
              <div key={i} className="sk sk--col" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
