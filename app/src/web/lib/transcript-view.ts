// トランスクリプトの見せ方（13.7。F8）。道具の呼び出しと結果を組にし、読み取り系の連続をまとめる
import type { TranscriptItem } from "@baton/shared";

export type ViewMode = "standard" | "detailed";

/** 読み取り系（連続したら「n 件の操作」にまとめる） */
export const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);

export type ToolPair = { use: TranscriptItem | null; result: TranscriptItem | null };

export type TranscriptRow =
  | { kind: "item"; key: string; item: TranscriptItem }
  | { kind: "tool"; key: string; pair: ToolPair }
  | { kind: "todo"; key: string; item: TranscriptItem; todos: TodoEntry[] }
  | { kind: "group"; key: string; pairs: ToolPair[] };

export type TodoEntry = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

export function todosOf(item: TranscriptItem): TodoEntry[] {
  const input = (item.body as { input?: { todos?: unknown } }).input;
  const list = Array.isArray(input?.todos) ? (input!.todos as unknown[]) : [];
  return list
    .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>) : {}))
    .filter((t) => typeof t.content === "string")
    .map((t) => ({
      content: t.content as string,
      status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
      ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
    }));
}

/** 最新の TodoWrite（TODO タブ） */
export function latestTodos(items: readonly TranscriptItem[]): TodoEntry[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool_use" && it.toolName === "TodoWrite") return todosOf(it);
  }
  return null;
}

function toolOf(p: ToolPair): string | null {
  return p.use?.toolName ?? p.result?.toolName ?? null;
}

/**
 * 行を組み立てる。
 * - tool_use と tool_result は toolUseId で 1 行にまとめる
 * - 標準: thinking は出さない。読み取り系が 2 つ以上続いたら 1 つのまとまり
 * - 詳細: すべて出す（まとめない）
 */
export function buildRows(items: readonly TranscriptItem[], mode: ViewMode): TranscriptRow[] {
  const results = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "tool_result" && it.toolUseId) results.set(it.toolUseId, it);
  const usedResults = new Set<string>();
  const rows: TranscriptRow[] = [];
  for (const it of items) {
    if (it.kind === "thinking" && mode === "standard") continue;
    if (it.kind === "tool_use") {
      if (it.toolName === "TodoWrite") {
        rows.push({ kind: "todo", key: `t${it.seq}`, item: it, todos: todosOf(it) });
        if (it.toolUseId) usedResults.add(it.toolUseId);
        continue;
      }
      const result = it.toolUseId ? (results.get(it.toolUseId) ?? null) : null;
      if (result && it.toolUseId) usedResults.add(it.toolUseId);
      rows.push({ kind: "tool", key: `u${it.seq}`, pair: { use: it, result } });
      continue;
    }
    if (it.kind === "tool_result") {
      if (it.toolUseId && usedResults.has(it.toolUseId)) continue;
      // 対になる tool_use が古くて読み込んでいない
      rows.push({ kind: "tool", key: `r${it.seq}`, pair: { use: null, result: it } });
      continue;
    }
    rows.push({ kind: "item", key: `i${it.seq}`, item: it });
  }
  if (mode === "detailed") return rows;
  // 読み取り系の連続をまとめる
  const out: TranscriptRow[] = [];
  let run: Extract<TranscriptRow, { kind: "tool" }>[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "group", key: `g${run[0]!.key}`, pairs: run.map((r) => r.pair) });
    else out.push(...run);
    run = [];
  };
  for (const r of rows) {
    const readOnly = r.kind === "tool" && READ_ONLY_TOOLS.has(toolOf(r.pair) ?? "") && !(r.pair.result?.isError ?? false);
    if (readOnly) {
      run.push(r as Extract<TranscriptRow, { kind: "tool" }>);
      continue;
    }
    flush();
    out.push(r);
  }
  flush();
  return out;
}

/** Edit・Write の差分（標準は先頭 12 行） */
export function patchPreview(result: TranscriptItem | null, mode: ViewMode): { lines: string[]; more: number } | null {
  const patch = (result?.body as { patch?: unknown } | undefined)?.patch;
  if (typeof patch !== "string" || patch === "") return null;
  const lines = patch.split("\n");
  if (mode === "detailed") return { lines, more: 0 };
  return { lines: lines.slice(0, 12), more: Math.max(0, lines.length - 12) };
}

/** 終了の 1 行（終了 · 3 分 12 秒 · 18 ターン）の数 */
export function resultStats(item: TranscriptItem): { minutes: number; seconds: number; turns: number | null; costUsdEst: number | null } {
  const b = item.body as { durationMs?: unknown; numTurns?: unknown; costUsdEst?: unknown };
  const ms = typeof b.durationMs === "number" ? b.durationMs : 0;
  const total = Math.round(ms / 1000);
  return {
    minutes: Math.floor(total / 60),
    seconds: total % 60,
    turns: typeof b.numTurns === "number" ? b.numTurns : null,
    costUsdEst: typeof b.costUsdEst === "number" ? b.costUsdEst : null,
  };
}
