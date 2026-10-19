// 成果物の一覧とプレビュー（v1 7.5）。プレビューは textContent で描く（HTML として解釈しない）
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TESTIDS, UI_TEXT, type ArtifactMeta } from "@baton/shared";
import { useArtifact } from "../api/queries.ts";
import { tailnetFileUrl } from "../lib/tailnet.ts";
import { compactNumber } from "../lib/time.ts";
import { spring } from "../motion/tokens.ts";
import { useTailnet } from "../state/tailnet.ts";
import { IconExternal, IconFile } from "./Icons.tsx";

export function ArtifactList({ artifacts }: { artifacts: ArtifactMeta[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ul className="artifact-list">
      {artifacts.map((a) => (
        <li key={a.id} className="artifact glass glass--card" data-testid={TESTIDS.artifactItem} data-id={a.id}>
          <button type="button" className="artifact__head" aria-expanded={openId === a.id} onClick={() => setOpenId((v) => (v === a.id ? null : a.id))}>
            <IconFile size={18} />
            <span className="artifact__title">{a.title}</span>
            <span className="artifact__path">{a.relPath}</span>
            <span className="artifact__size">{compactNumber(a.sizeBytes)}B</span>
          </button>
          <AnimatePresence initial={false}>{openId === a.id && <ArtifactViewer artifact={a} />}</AnimatePresence>
        </li>
      ))}
    </ul>
  );
}

export function ArtifactViewer({ artifact }: { artifact: ArtifactMeta }) {
  const q = useArtifact(artifact.id);
  const tailnet = useTailnet();
  const href = tailnet.ok && tailnet.url && artifact.projectSlug ? tailnetFileUrl(tailnet.url, artifact.projectSlug, artifact.relPath) : null;
  return (
    <motion.div className="artifact__viewer" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={spring.gentle}>
      {q.data ? (
        <pre className="artifact__preview" data-testid={TESTIDS.artifactPreview}>
          {q.data.previewText ?? ""}
        </pre>
      ) : (
        <div className="sk sk--block" aria-busy="true" />
      )}
      {href && (
        <a className="chip-button" href={href} target="_blank" rel="noopener noreferrer">
          <IconExternal size={15} />
          <span>{UI_TEXT.openOnMini}</span>
        </a>
      )}
    </motion.div>
  );
}
