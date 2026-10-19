// ホーム（7.3）。指示カードの一覧。/i/:id のときは詳細シートを上に重ねる
import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence } from "motion/react";
import { useMatch, useNavigate } from "@tanstack/react-router";
import type { InstructionSummary } from "@baton/shared";
import { useActiveList } from "../api/queries.ts";
import { focusComposer } from "../components/Composer.tsx";
import { InstructionList } from "../components/InstructionList.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { dismissBootSkeleton } from "../lib/boot.ts";
import { useNow } from "../lib/useNow.ts";
import { InstructionSheet } from "./InstructionSheet.tsx";

const INTERACTIVE = "[data-card], button, a, input, textarea, select, [role=menu], [role=dialog], .sheet-layer";

export function Home() {
  const list = useActiveList();
  const now = useNow();
  const navigate = useNavigate();
  const match = useMatch({ from: "/home/i/$id", shouldThrow: false });
  const sheetId = match?.params.id ?? null;
  const down = useRef<{ x: number; y: number } | null>(null);

  const ready = list.data !== undefined;
  useEffect(() => {
    // 本物の一覧かスケルトンを React が描いたら、埋め込みのスケルトンを外す
    dismissBootSkeleton({ immediate: !ready });
  }, [ready]);

  const open = useCallback(
    (item: InstructionSummary) => {
      void navigate({ to: "/i/$id", params: { id: item.id } });
    },
    [navigate],
  );
  const close = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  // 一覧の空白をタップしたら入力欄へ（iOS は pointerup の中で同期的に focus。7.4）
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) {
      down.current = null;
      return;
    }
    down.current = { x: e.clientX, y: e.clientY };
    // 後から来る互換の mousedown でフォーカスが外れないように（スクロールは touch-action が決めるので止まらない）
    if (e.pointerType !== "mouse") e.preventDefault();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    focusComposer();
  };

  return (
    <main className="screen screen--home" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      {ready ? <InstructionList items={list.data.items} now={now} onOpen={open} /> : <SkeletonScreen variant="home" />}
      <AnimatePresence>{sheetId && <InstructionSheet key={sheetId} id={sheetId} onClose={close} />}</AnimatePresence>
    </main>
  );
}
