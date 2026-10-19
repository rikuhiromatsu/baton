// 画面をまたぐ小さな状態
import { create } from "zustand";
import type { InstructionSummary } from "@baton/shared";

export type ActionMenuState = { instruction: InstructionSummary; x: number; y: number } | null;

type Ui = {
  /** いまドラッグ中のカード（同時に 1 枚だけ。7.6） */
  draggingId: string | null;
  setDragging: (id: string | null) => void;
  /** 差し戻しシートの対象 */
  sendBackFor: InstructionSummary | null;
  setSendBackFor: (i: InstructionSummary | null) => void;
  /** 長押し・右クリックの操作メニュー */
  actionMenu: ActionMenuState;
  setActionMenu: (m: ActionMenuState) => void;
  /** 409 などで揺らすカード（clientId → 揺らした時刻） */
  shakes: Record<string, number>;
  shake: (clientId: string) => void;
  /** 送信アニメーションの泡（入力欄 → カード） */
  bubble: { clientId: string; text: string } | null;
  setBubble: (b: { clientId: string; text: string } | null) => void;
  /** 起動後、最初の一覧を描いたか（登場アニメーションを 1 回だけにする） */
  listRevealed: boolean;
  setListRevealed: () => void;
  /** 初回の案内（D-38） */
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
};

export const useUi = create<Ui>()((set) => ({
  draggingId: null,
  setDragging: (draggingId) => set({ draggingId }),
  sendBackFor: null,
  setSendBackFor: (sendBackFor) => set({ sendBackFor }),
  actionMenu: null,
  setActionMenu: (actionMenu) => set({ actionMenu }),
  shakes: {},
  shake: (clientId) => set((s) => ({ shakes: { ...s.shakes, [clientId]: Date.now() } })),
  bubble: null,
  setBubble: (bubble) => set({ bubble }),
  listRevealed: false,
  setListRevealed: () => set({ listRevealed: true }),
  onboardingOpen: false,
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
}));
