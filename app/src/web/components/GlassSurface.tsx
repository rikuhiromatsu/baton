// ガラス面の共通部品（7.5・7.8）
import { forwardRef, type HTMLAttributes } from "react";

export type GlassVariant = "bar" | "card" | "sheet" | "chip";

type Props = HTMLAttributes<HTMLDivElement> & { variant?: GlassVariant; as?: "div" | "section" | "header" | "nav" };

export const GlassSurface = forwardRef<HTMLDivElement, Props>(function GlassSurface(
  { variant = "card", className = "", as: Tag = "div", ...rest },
  ref,
) {
  return <Tag ref={ref} className={`glass glass--${variant} ${className}`} {...rest} />;
});

export function glassClass(variant: GlassVariant, extra = ""): string {
  return `glass glass--${variant} ${extra}`.trim();
}
