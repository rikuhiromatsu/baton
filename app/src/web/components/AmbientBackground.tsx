// 白地に 4 つの淡い光とノイズ（7.8）。reduced-motion のときは漂わせない（F6）
import { useReducedMotion } from "motion/react";

export function AmbientBackground() {
  const reduce = useReducedMotion();
  const drift = reduce ? "" : " ambient--drift";
  return (
    <div className={`ambient${drift}`} aria-hidden="true" data-reduced={reduce ? "true" : "false"}>
      <div className="ambient__glow ambient__glow--1" />
      <div className="ambient__glow ambient__glow--2" />
      <div className="ambient__glow ambient__glow--3" />
      <div className="ambient__glow ambient__glow--4" />
      <div className="ambient__noise" />
    </div>
  );
}
