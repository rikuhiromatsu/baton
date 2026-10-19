// 送信待ち・送信失敗の指示（7.4 の 7）。オフライン中に打った分を再起動後も失わないよう永続化する
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appStorage } from "./storage.ts";

export type OutboxState = "sending" | "failed" | "waiting";
export type OutboxItem = { clientId: string; body: string; createdAt: number; state: OutboxState };

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
    { name: "baton-outbox", storage: appStorage, skipHydration: true },
  ),
);
