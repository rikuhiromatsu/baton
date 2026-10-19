// 全画面スケルトン（7.9）。本物と同じ配置の角丸ブロックと、左から右へ流れる光沢
import { useEffect, useState } from "react";
import { TESTIDS, UI_TEXT } from "@baton/shared";

const RELOAD_AFTER_MS = 10_000;

export function SkeletonScreen({ variant = "home" }: { variant?: "home" | "detail" | "list" }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), RELOAD_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  const cards = variant === "detail" ? 3 : 5;
  return (
    <div className={`skeleton skeleton--${variant}`} data-testid={TESTIDS.skeletonScreen} aria-busy="true">
      {late && (
        <button type="button" className="skeleton__reload glass glass--chip" data-testid={TESTIDS.skeletonReload} onClick={() => location.reload()}>
          {UI_TEXT.reload}
        </button>
      )}
      {variant === "detail" ? (
        <>
          <div className="sk sk--title" />
          <div className="sk sk--line" />
          <div className="sk sk--line sk--short" />
          <div className="sk sk--label" />
          {Array.from({ length: cards }, (_, i) => (
            <div key={i} className="sk sk--row" />
          ))}
        </>
      ) : (
        <>
          <div className="sk sk--label" />
          {Array.from({ length: cards }, (_, i) => (
            <div key={i} className="sk sk--card" />
          ))}
        </>
      )}
    </div>
  );
}
