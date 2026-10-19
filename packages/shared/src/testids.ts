// E2E との契約（設計書 7.12）。画面はここの値を data-testid に使い、E2E もここから参照する。
import type { InstructionStatus } from "./status.ts";

export const TESTIDS = {
  composerInput: "composer-input",
  composerSend: "composer-send",
  instructionList: "instruction-list",
  /** data-id・data-status 属性付き */
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
  taskTree: "task-tree",
  /** data-kind・data-status 属性付き */
  taskNode: "task-node",
  artifactItem: "artifact-item",
  artifactPreview: "artifact-preview",
  eventLog: "event-log",
  /** data-online 属性付き */
  runnerDot: "runner-dot",
  usageRing: "usage-ring",
  skeletonScreen: "skeleton-screen",
  skeletonReload: "skeleton-reload",
  menuButton: "menu-button",
  menuProjects: "menu-projects",
  menuArchive: "menu-archive",
  menuUsage: "menu-usage",
  menuLogout: "menu-logout",
  projectCard: "project-card",
  archiveList: "archive-list",
  loginGoogle: "login-google",
  loginError: "login-error",
} as const;

/** index.html に埋め込む入力欄の id（7.4） */
export const BOOT_COMPOSER_ID = "boot-composer";
/** index.html に埋め込む全画面スケルトンの id */
export const BOOT_SKELETON_ID = "boot-skeleton";
