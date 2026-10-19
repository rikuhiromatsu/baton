// 指示のステータスと遷移（設計書 3.3〜3.5）。Worker の検証と Web のフリックの両方がここだけを見る。

export const INSTRUCTION_STATUSES = [
  "queued",
  "running",
  "needs_decision",
  "review",
  "done",
  "failed",
  "canceled",
  "archived",
] as const;
export type InstructionStatus = (typeof INSTRUCTION_STATUSES)[number];

export const CEO_ACTIONS = ["approve", "send_back", "cancel", "archive", "retry", "restore"] as const;
export type CeoAction = (typeof CEO_ACTIONS)[number];

export type SwipeDirection = "right" | "left";
export type SwipeOutcome = CeoAction | "open_decision" | null;

/** 3.5 の表。null はその方向に動かない。"open_decision" は画面側の動作（状態は変えない） */
export const SWIPE_MAP: Record<InstructionStatus, Record<SwipeDirection, SwipeOutcome>> = {
  queued: { right: null, left: "cancel" },
  running: { right: null, left: "cancel" },
  needs_decision: { right: "open_decision", left: "cancel" },
  review: { right: "approve", left: "send_back" },
  done: { right: "archive", left: null },
  failed: { right: "retry", left: "archive" },
  canceled: { right: "retry", left: "archive" },
  archived: { right: "restore", left: null },
};

/** CEO の操作で許される遷移（restore 以外）。restore は archivedFrom で決まる */
const CEO_TRANSITIONS: Record<Exclude<CeoAction, "restore">, { from: readonly InstructionStatus[]; to: InstructionStatus }> = {
  approve: { from: ["review"], to: "done" },
  send_back: { from: ["review"], to: "queued" },
  cancel: { from: ["queued", "running", "needs_decision"], to: "canceled" },
  archive: { from: ["done", "failed", "canceled"], to: "archived" },
  retry: { from: ["failed", "canceled"], to: "queued" },
};

/** アーカイブから戻せる元の状態 */
export const RESTORABLE_STATUSES = ["done", "canceled", "failed"] as const satisfies readonly InstructionStatus[];

/**
 * CEO の操作による次の状態。許されない組み合わせは null。
 * restore のときは archivedFrom（アーカイブ前の状態）が必要。
 */
export function nextStatus(
  from: InstructionStatus,
  action: CeoAction,
  archivedFrom?: InstructionStatus,
): InstructionStatus | null {
  if (action === "restore") {
    if (from !== "archived" || archivedFrom === undefined) return null;
    return (RESTORABLE_STATUSES as readonly InstructionStatus[]).includes(archivedFrom) ? archivedFrom : null;
  }
  const rule = CEO_TRANSITIONS[action];
  return rule.from.includes(from) ? rule.to : null;
}

/** ランナー・システムによる遷移（3.4）。from → 許される to */
export const SYSTEM_TRANSITIONS: Record<InstructionStatus, readonly InstructionStatus[]> = {
  queued: ["running"],
  running: ["queued", "needs_decision", "review", "failed"],
  needs_decision: ["queued"],
  review: [],
  done: [],
  failed: [],
  canceled: [],
  archived: [],
};

export function canSystemTransition(from: InstructionStatus, to: InstructionStatus): boolean {
  return SYSTEM_TRANSITIONS[from].includes(to);
}

/** ホームでの並び（7.3）。archived はホームに出さない */
export const HOME_STATUS_ORDER = [
  "needs_decision",
  "review",
  "running",
  "queued",
  "failed",
  "canceled",
  "done",
] as const satisfies readonly InstructionStatus[];

/** まとまりの見出し（7.11） */
export const STATUS_LABELS: Record<InstructionStatus, string> = {
  queued: "待機",
  running: "実行中",
  needs_decision: "判断待ち",
  review: "確認",
  done: "完了",
  failed: "失敗",
  canceled: "取消",
  archived: "アーカイブ",
};

/** フリックの下地の文言（7.11） */
export const ACTION_LABELS: Record<CeoAction, string> = {
  approve: "承認",
  send_back: "差し戻し",
  cancel: "取消",
  archive: "アーカイブ",
  retry: "再実行",
  restore: "戻す",
};

/** フリックの下地の色（CSS 変数名。7.6） */
export const ACTION_COLORS: Record<CeoAction | "open_decision", string> = {
  approve: "--accent-success",
  send_back: "--accent-warning",
  cancel: "--accent-danger",
  archive: "--text-tertiary",
  retry: "--accent",
  restore: "--accent",
  open_decision: "--accent-decision",
};

/** 取り消しトーストを出さない操作（3.5） */
export const NO_UNDO_ACTIONS: readonly CeoAction[] = ["send_back"];

/** 完了・取消を一覧に出す日数（7.3） */
export const RECENT_DAYS_FOR_CLOSED = 7;
