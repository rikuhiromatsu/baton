// E2E との契約（v1 設計書 7.12、DESIGN-v2 13.15）。画面はここの値を data-testid に使い、E2E もここから参照する。
// 規約: 名前は kebab-case。状態は data-* 属性で出す（コメントに属性名を書く）。動的な名前は関数にする。
// v2 で変えたもの: menu-projects → menu-org。消したもの: event-log・task-tree（トランスクリプトと TODO タブへ）。
import type { InstructionStatus } from "./status.ts";

/** 指示の詳細の本文のタブ（13.7） */
export const DETAIL_TABS = ["transcript", "todo", "diff", "report", "artifacts"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export const TESTIDS = {
  // ───── v1（残すもの） ─────
  composerInput: "composer-input",
  composerSend: "composer-send",
  instructionList: "instruction-list",
  /** data-id・data-status・data-group 属性付き */
  instructionCard: "instruction-card",
  instructionGroup: (status: InstructionStatus) => `instruction-group-${status}`,
  swipeUnderlayLeft: "swipe-underlay-left",
  swipeUnderlayRight: "swipe-underlay-right",
  undoToast: "undo-toast",
  undoButton: "undo-button",
  errorToast: "error-toast",
  instructionSheet: "instruction-sheet",
  sheetClose: "sheet-close",
  reportText: "report-text",
  decisionPanel: "decision-panel",
  decisionOption: (n: number) => `decision-option-${n}`,
  decisionInput: "decision-input",
  decisionSubmit: "decision-submit",
  sendbackInput: "sendback-input",
  sendbackSubmit: "sendback-submit",
  /** data-kind・data-status 属性付き */
  taskNode: "task-node",
  artifactItem: "artifact-item",
  artifactPreview: "artifact-preview",
  /** data-online・data-auth 属性付き */
  runnerDot: "runner-dot",
  /** data-utilization（5 時間枠）・data-weekly・data-status 属性付き */
  usageRing: "usage-ring",
  skeletonScreen: "skeleton-screen",
  skeletonReload: "skeleton-reload",
  menuButton: "menu-button",
  menuOrg: "menu-org",
  menuArchive: "menu-archive",
  menuUsage: "menu-usage",
  menuSettings: "menu-settings",
  menuNewTopic: "menu-new-topic",
  menuLogout: "menu-logout",
  menuGuide: "menu-guide",
  onboarding: "onboarding",
  onboardingNext: "onboarding-next",
  onboardingBack: "onboarding-back",
  onboardingSkip: "onboarding-skip",
  projectCard: "project-card",
  archiveList: "archive-list",
  loginGoogle: "login-google",
  loginError: "login-error",

  // ───── サイドパネル（13.3） ─────
  sidebar: "sidebar",
  sidebarToggle: "sidebar-toggle",
  sidebarDrawer: "sidebar-drawer",
  sidebarCoo: "sidebar-coo",
  sidebarApprovals: "sidebar-approvals",
  /** data-project-id・data-active 属性付き */
  sidebarItem: "sidebar-item",
  /** data-kind 属性付き（needs_decision・review・running） */
  sidebarCount: "sidebar-count",
  sidebarLeaderLink: "sidebar-leader-link",
  sidebarUnread: "sidebar-unread",

  // ───── 会話（13.4） ─────
  /** data-thread-id・data-kind 属性付き */
  thread: "thread",
  /** data-seq・data-author・data-kind・data-status 属性付き */
  message: "message",
  messageTyping: "message-typing",
  messageAck: "message-ack",
  messageInstructionCard: "message-instruction-card",
  leaderLink: "leader-link",
  backToCoo: "back-to-coo",
  awaitingReply: "awaiting-reply",
  latestPill: "latest-pill",
  threadTarget: "thread-target",
  contextChip: "context-chip",
  contextChipClear: "context-chip-clear",
  interruptButton: "interrupt-button",
  newTopic: "new-topic",

  // ───── プロジェクト案（13.6） ─────
  /** data-proposal-id・data-status 属性付き */
  proposalCard: "proposal-card",
  proposalWorkspace: "proposal-workspace",
  /** data-path 属性付き */
  proposalRepoOption: "proposal-repo-option",
  proposalAccept: "proposal-accept",
  proposalRevise: "proposal-revise",

  // ───── 指示カードの列（13.8） ─────
  cardsPanel: "cards-panel",
  cardsButton: "cards-button",
  talkingBadge: "talking-badge",

  // ───── 指示の詳細（13.7） ─────
  /** data-session-id・data-role・data-status 属性付き */
  sessionTab: "session-tab",
  detailTab: (name: DetailTab) => `detail-tab-${name}`,
  transcript: "transcript",
  /** data-kind・data-seq・data-tool 属性付き */
  transcriptItem: "transcript-item",
  transcriptGroup: "transcript-group",
  transcriptExpand: "transcript-expand",
  viewMode: "view-mode",
  followupInput: "followup-input",
  followupSend: "followup-send",
  /** data-decision-id 属性付き */
  approvalCard: "approval-card",
  approvalAllow: "approval-allow",
  approvalDeny: "approval-deny",
  approvalReason: "approval-reason",
  approvalSuggestion: "approval-suggestion",
  resumeButton: "resume-button",
  todoList: "todo-list",
  todoItem: "todo-item",
  diffFile: "diff-file",
  diffView: "diff-view",
  branchChip: "branch-chip",

  // ───── 組織図（13.9） ─────
  orgChart: "org-chart",
  /** data-agent-id・data-role・data-state 属性付き */
  orgNode: "org-node",
  orgProject: "org-project",
  projectSheet: "project-sheet",
  agentSheet: "agent-sheet",
  repoLinkButton: "repo-link-button",
  repoOption: "repo-option",
  repoUnlinkButton: "repo-unlink-button",
  repoCreateButton: "repo-create-button",

  // ───── 設定（13.10） ─────
  settings: "settings",
  /** data-value 属性付き（auto・light・dark） */
  themeOption: "theme-option",
  pushToggle: "push-toggle",
  pushIosHint: "push-ios-hint",
  pushDevice: "push-device",
  botTokenCreate: "bot-token-create",
  botTokenValue: "bot-token-value",
  botTokenItem: "bot-token-item",
  botTokenRevoke: "bot-token-revoke",
  botAuditItem: "bot-audit-item",

  // ───── その他 ─────
  toastMessage: "toast-message",
  quotaSheet: "quota-sheet",
} as const;

/** index.html に埋め込む入力欄の id（v1 7.4・DESIGN-v2 13.5） */
export const BOOT_COMPOSER_ID = "boot-composer";
/** index.html に埋め込む全画面スケルトンの id */
export const BOOT_SKELETON_ID = "boot-skeleton";

/** テーマ（13.11）。localStorage のキーと html の data-theme の値 */
export const THEME_STORAGE_KEY = "baton.theme";
export const THEME_VALUES = ["auto", "light", "dark"] as const;
export type ThemeValue = (typeof THEME_VALUES)[number];
