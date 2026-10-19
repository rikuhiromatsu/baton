// 入力欄の下書き（localStorage 永続。未ログインで打った分もログイン後に戻す。7.4）
// 宛先ごとに持つ（COO・各リーダー・メンバーへの追加の依頼）。埋め込みの入力欄は COO 宛て（13.5）
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appStorage } from "./storage.ts";

export const COO_DRAFT_KEY = "coo";

type DraftState = {
  texts: Record<string, string>;
  setText: (key: string, text: string) => void;
  clear: (key: string) => void;
};

export const useDraft = create<DraftState>()(
  persist(
    (set) => ({
      texts: {},
      setText: (key, text) =>
        set((s) => {
          if ((s.texts[key] ?? "") === text) return s;
          const texts = { ...s.texts };
          if (text) texts[key] = text;
          else delete texts[key];
          return { texts };
        }),
      clear: (key) =>
        set((s) => {
          if (!(key in s.texts)) return s;
          const texts = { ...s.texts };
          delete texts[key];
          return { texts };
        }),
    }),
    { name: "baton-draft-v2", storage: appStorage, skipHydration: true },
  ),
);

export function getDraft(key: string): string {
  return useDraft.getState().texts[key] ?? "";
}
