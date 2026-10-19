// 指示の下書き（localStorage 永続。未ログインで打った分もログイン後に戻す。7.4）
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { appStorage } from "./storage.ts";

type DraftState = {
  text: string;
  setText: (text: string) => void;
  clear: () => void;
};

export const useDraft = create<DraftState>()(
  persist(
    (set) => ({
      text: "",
      setText: (text) => set({ text }),
      clear: () => set({ text: "" }),
    }),
    { name: "baton-draft", storage: appStorage, skipHydration: true },
  ),
);
