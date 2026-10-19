// tailnet 直結の有無（1.4・7.5）
import { create } from "zustand";

type Tailnet = { url: string | null; ok: boolean; set: (url: string | null, ok: boolean) => void };

export const useTailnet = create<Tailnet>()((set) => ({
  url: null,
  ok: false,
  set: (url, ok) => set({ url, ok }),
}));
