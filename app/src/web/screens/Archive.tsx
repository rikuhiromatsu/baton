// アーカイブ（7.2）。archived の指示。右フリックで戻す
import { useCallback, useEffect } from "react";
import type { InstructionSummary } from "@baton/shared";
import { useArchivedList } from "../api/queries.ts";
import { ArchiveList } from "../components/InstructionList.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { dismissBootSkeleton } from "../lib/boot.ts";
import { useNow } from "../lib/useNow.ts";

export function Archive() {
  const q = useArchivedList();
  const now = useNow();
  useEffect(() => dismissBootSkeleton({ immediate: !q.data }), [q.data]);
  // アーカイブのカードはタップで開かない（フリック・キーボード・長押しで戻す）
  const noop = useCallback((_: InstructionSummary) => {}, []);
  return <main className="screen screen--archive">{q.data ? <ArchiveList items={q.data.items} now={now} onOpen={noop} /> : <SkeletonScreen variant="list" />}</main>;
}
