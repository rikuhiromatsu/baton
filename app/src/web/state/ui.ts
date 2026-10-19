// 画面をまたぐ小さな状態
import { create } from "zustand";
import type { InstructionSummary } from "@baton/shared";

export type ActionMenuState = { instruction: InstructionSummary; x: number; y: number } | null;

/** 発言の長押し・右クリックのメニュー（コピー・作業を見る） */
export type MessageMenuState = { text: string; to: { instructionId: string; sessionId: string | null } | null; x: number; y: number } | null;

/** 指示の詳細で選んでいるエージェントのタブ（入力欄の宛先を決める。D-54・F14） */
export type DetailTarget =
  | { instructionId: string; role: "coo"; threadId: string }
  | { instructionId: string; role: "leader"; threadId: string; projectId: string | null }
  | { instructionId: string; role: "member"; sessionId: string; running: boolean }
  | null;

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
  messageMenu: MessageMenuState;
  setMessageMenu: (m: MessageMenuState) => void;
  /** 409 などで揺らすカード（clientId → 揺らした時刻） */
  shakes: Record<string, number>;
  shake: (clientId: string) => void;
  /** 起動後、最初の一覧を描いたか（登場アニメーションを 1 回だけにする） */
  listRevealed: boolean;
  setListRevealed: () => void;
  /** 初回の案内（D-38） */
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  /** サイドパネル: デスクトップのレール（折りたたみ）・中間幅とモバイルのドロワー（D-72） */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  /** 指示カードの列（デスクトップは折りたためる）・モバイルのシート */
  cardsCollapsed: boolean;
  setCardsCollapsed: (v: boolean) => void;
  cardsSheetOpen: boolean;
  setCardsSheetOpen: (v: boolean) => void;
  /** 使用量の詳細シート */
  quotaSheetOpen: boolean;
  setQuotaSheetOpen: (v: boolean) => void;
  /** 指示の詳細の宛先 */
  detailTarget: DetailTarget;
  setDetailTarget: (t: DetailTarget) => void;
  /** いま見えているスレッド（トースト・既読の判定） */
  visibleThreadId: string | null;
  setVisibleThreadId: (id: string | null) => void;
  /** プロジェクトの指定（チップ）を外した /p/:id（D-71。もう一度プロジェクトを選ぶまで） */
  chipCleared: string | null;
  setChipCleared: (projectId: string | null) => void;
};

export const useUi = create<Ui>()((set) => ({
  draggingId: null,
  setDragging: (draggingId) => set({ draggingId }),
  sendBackFor: null,
  setSendBackFor: (sendBackFor) => set({ sendBackFor }),
  actionMenu: null,
  setActionMenu: (actionMenu) => set({ actionMenu }),
  messageMenu: null,
  setMessageMenu: (messageMenu) => set({ messageMenu }),
  shakes: {},
  shake: (clientId) => set((s) => ({ shakes: { ...s.shakes, [clientId]: Date.now() } })),
  listRevealed: false,
  setListRevealed: () => set({ listRevealed: true }),
  onboardingOpen: false,
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  sidebarCollapsed: false,
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  cardsCollapsed: false,
  setCardsCollapsed: (cardsCollapsed) => set({ cardsCollapsed }),
  cardsSheetOpen: false,
  setCardsSheetOpen: (cardsSheetOpen) => set({ cardsSheetOpen }),
  quotaSheetOpen: false,
  setQuotaSheetOpen: (quotaSheetOpen) => set({ quotaSheetOpen }),
  detailTarget: null,
  setDetailTarget: (detailTarget) => set({ detailTarget }),
  visibleThreadId: null,
  setVisibleThreadId: (visibleThreadId) => set({ visibleThreadId }),
  chipCleared: null,
  setChipCleared: (chipCleared) => set({ chipCleared }),
}));
