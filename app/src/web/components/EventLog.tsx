// 実行ログ（購読して追記。tailnet 直結時は「生ログ」に切り替えられる。7.5）
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT, type AgentEvent } from "@baton/shared";
import { qk } from "../api/keys.ts";
import { eventsQueryFn } from "../api/queries.ts";
import { openRawLog } from "../lib/tailnet.ts";
import { useTailnet } from "../state/tailnet.ts";

/** content は unknown なので、文章らしいものを 1 行にする */
export function formatEventContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    for (const key of ["text", "summary", "message", "question", "reason", "title"]) {
      if (typeof c[key] === "string") return c[key] as string;
    }
    if (typeof c.tool === "string") {
      const args = c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : null;
      const path = args && typeof args.path === "string" ? ` ${args.path}` : "";
      return `${c.tool}${path}`;
    }
    if (typeof c.stage === "string") return typeof c.model === "string" ? `${c.stage} · ${c.model}` : c.stage;
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return String(content);
}

function eventTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function EventLog({ instructionId }: { instructionId: string }) {
  const qc = useQueryClient();
  const tailnet = useTailnet();
  const [mode, setMode] = useState<"log" | "raw">("log");
  const q = useQuery({ queryKey: qk.events(instructionId), queryFn: eventsQueryFn(qc, instructionId) });
  const rawAvailable = tailnet.ok && !!tailnet.url;
  const items: AgentEvent[] = q.data?.items ?? [];

  return (
    <div className="event-log-wrap">
      <div className="section__head">
        {rawAvailable ? (
          <div className="segmented" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "log"} className="segmented__item" onClick={() => setMode("log")}>
              {UI_TEXT.sectionLog}
            </button>
            <button type="button" role="tab" aria-selected={mode === "raw"} className="segmented__item" onClick={() => setMode("raw")}>
              {UI_TEXT.sectionRawLog}
            </button>
          </div>
        ) : (
          <h3 className="section__label">{UI_TEXT.sectionLog}</h3>
        )}
      </div>
      {mode === "raw" && rawAvailable ? (
        <RawLog base={tailnet.url!} instructionId={instructionId} />
      ) : (
        <ol className="event-log" data-testid={TESTIDS.eventLog}>
          {items.map((e) => (
            <li key={e.seq} className={`event event--${e.kind}`}>
              <span className="event__time">{eventTime(e.createdAt)}</span>
              <span className="event__kind">{e.kind}</span>
              <span className="event__text">{formatEventContent(e.content)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const RAW_MAX_LINES = 500;

function RawLog({ base, instructionId }: { base: string; instructionId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const src = openRawLog(base, instructionId, (line) => setLines((prev) => [...prev.slice(-(RAW_MAX_LINES - 1)), line]));
    return () => src.close();
  }, [base, instructionId]);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre ref={ref} className="raw-log">
      {lines.join("\n")}
    </pre>
  );
}
