// 送信待ち・送信失敗の発言（v1 7.4 の 7 を発言に。13.5）。オフライン中に打った分を再起動後も失わないよう永続化する
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appStorage } from "./storage.ts";

export type OutboxState = "sending" | "failed" | "waiting";

/** 宛先: スレッドへの発言か、メンバーへの追加の依頼（D-54） */
export type OutboxTarget = { kind: "thread"; threadId: string } | { kind: "session"; sessionId: string; instructionId: string };

export type OutboxItem = {
  clientId: string;
  target: OutboxTarget;
  body: string;
  contextProjectId?: string;
  instructionId?: string;
  createdAt: number;
  state: OutboxState;
};

type Outbox = {
  items: Record<string, OutboxItem>;
  put: (item: OutboxItem) => void;
  setState: (clientId: string, state: OutboxState) => void;
  remove: (clientId: string) => void;
};

export const useOutbox = create<Outbox>()(
  persist(
    (set) => ({
      items: {},
      put: (item) => set((s) => ({ items: { ...s.items, [item.clientId]: item } })),
      setState: (clientId, state) =>
        set((s) => {
          const cur = s.items[clientId];
          return cur ? { items: { ...s.items, [clientId]: { ...cur, state } } } : s;
        }),
      remove: (clientId) =>
        set((s) => {
          if (!s.items[clientId]) return s;
          const items = { ...s.items };
          delete items[clientId];
          return { items };
        }),
    }),
    { name: "baton-outbox-v2", storage: appStorage, skipHydration: true },
  ),
);

export function outboxForThread(items: Record<string, OutboxItem>, threadId: string): OutboxItem[] {
  return Object.values(items)
    .filter((i) => i.target.kind === "thread" && i.target.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function outboxForSession(items: Record<string, OutboxItem>, sessionId: string): OutboxItem[] {
  return Object.values(items)
    .filter((i) => i.target.kind === "session" && i.target.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
