// 返事のストリーミング（4.7・D-80）。message.delta を発言ごとの文字列に継ぎ足す。D1 には無いのでメモリだけ
import { create } from "zustand";

export type StreamState = {
  threadId: string;
  text: string;
  activity: string | null;
};

export type DeltaInput = { offset: number; delta: string; reset?: boolean; activity?: string | null };

/**
 * 差分を継ぎ足す（純粋関数。F13）。
 * - reset: それまでの文章を前置きとして外す（offset 0 から書き直し）
 * - offset が今の長さと同じ: そのまま足す
 * - offset が今の長さより小さい: 重なった分を捨てて足す（同じ差分が二度届いても壊れない）
 * - offset が今の長さより大きい: 飛んでいる（取り直しが要る）→ null
 */
export function applyDelta(prev: string, ev: DeltaInput): string | null {
  const base = ev.reset ? "" : prev;
  if (ev.offset > base.length) return null;
  return base.slice(0, ev.offset) + ev.delta;
}

type Streams = {
  byId: Record<string, StreamState>;
  /** 発言が streaming で届いた（REST の本文から始める。再接続のときもここから続ける） */
  begin: (messageId: string, threadId: string, body: string) => void;
  /** 戻り値 false は飛んでいた（取り直しが要る） */
  delta: (messageId: string, threadId: string, ev: DeltaInput) => boolean;
  end: (messageId: string) => void;
};

export const useStreams = create<Streams>()((set, get) => ({
  byId: {},
  begin: (messageId, threadId, body) =>
    set((s) => {
      const cur = s.byId[messageId];
      // 既に先の文字まで届いていれば、短い REST の本文で巻き戻さない
      if (cur && cur.text.length >= body.length) return s;
      return { byId: { ...s.byId, [messageId]: { threadId, text: body, activity: cur?.activity ?? null } } };
    }),
  delta: (messageId, threadId, ev) => {
    const cur = get().byId[messageId] ?? { threadId, text: "", activity: null };
    const next = applyDelta(cur.text, ev);
    if (next === null) return false;
    const activity = ev.activity === undefined ? cur.activity : ev.activity;
    set((s) => ({ byId: { ...s.byId, [messageId]: { threadId, text: next, activity } } }));
    return true;
  },
  end: (messageId) =>
    set((s) => {
      if (!s.byId[messageId]) return s;
      const byId = { ...s.byId };
      delete byId[messageId];
      return { byId };
    }),
}));
