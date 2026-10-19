// トースト（取り消し・失敗）。同時に出すのは 1 枚（新しいものが前のものを置き換える）
import { create } from "zustand";
import type { CeoAction } from "@baton/shared";

export type Toast =
  | { id: string; kind: "undo"; action: CeoAction; instructionId: string; transitionId: string; createdAt: number; duration: number }
  | { id: string; kind: "sendFailed"; clientId: string; createdAt: number }
  | { id: string; kind: "updateFailed"; createdAt: number };

type Toasts = {
  toast: Toast | null;
  show: (t: Toast) => void;
  dismiss: (id?: string) => void;
};

export const useToasts = create<Toasts>()((set) => ({
  toast: null,
  show: (toast) => set({ toast }),
  dismiss: (id) => set((s) => (id === undefined || s.toast?.id === id ? { toast: null } : s)),
}));

let seq = 0;
export function toastId(): string {
  seq += 1;
  return `t${Date.now()}-${seq}`;
}
