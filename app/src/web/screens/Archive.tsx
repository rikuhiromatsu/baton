// アーカイブ（v1 7.2）。archived の指示。右フリックで戻す
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { UI_TEXT, type InstructionSummary } from "@baton/shared";
import { useArchivedList } from "../api/queries.ts";
import { ArchiveList } from "../components/InstructionList.tsx";
import { ScreenHeader } from "../components/ScreenHeader.tsx";
import { SkeletonScreen } from "../components/SkeletonScreen.tsx";
import { useNow } from "../lib/useNow.ts";

export function ArchiveScreen() {
  const q = useArchivedList();
  const now = useNow();
  const navigate = useNavigate();
  const open = useCallback((item: InstructionSummary) => void navigate({ to: "/i/$id", params: { id: item.id } }), [navigate]);
  return (
    <div className="screen screen--archive">
      <ScreenHeader cards={false} title={<span className="thread-title">{UI_TEXT.menuArchive}</span>} />
      <div className="archive-scroll">{q.data ? <ArchiveList items={q.data.items} now={now} onOpen={open} /> : <SkeletonScreen variant="list" />}</div>
    </div>
  );
}
