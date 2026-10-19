// 指示のステータスと遷移（v1 設計書 3.3〜3.5、DESIGN-v2 4.4・13.8）。
// Worker の検証と Web のフリックの両方がここだけを見る。
// v2 で足したもの: 作成（runner）、reopen（review/done → running、runner）、needs_decision → running（ceo の回答）、
// 開いた判断のある running を「判断待ち」のまとまりに出す displayGroup()、それに合わせたフリック swipeActionFor()、
// 組織図・サイドパネルのエージェントの状態 deriveAgentState() とプロジェクトの件数 countInstructions()。

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

/** running の中の段階（DESIGN-v2 5.5） */
export const INSTRUCTION_PHASES = ["leader", "members", "coo"] as const;
export type InstructionPhase = (typeof INSTRUCTION_PHASES)[number];

export const CEO_ACTIONS = ["approve", "send_back", "cancel", "archive", "retry", "restore"] as const;
export type CeoAction = (typeof CEO_ACTIONS)[number];

export type SwipeDirection = "right" | "left";
export type SwipeOutcome = CeoAction | "open_decision" | null;

/**
 * まとまりごとのフリック（v1 3.5 の表。v2 でも同じ）。null はその方向に動かない。
 * "open_decision" は画面側の動作（状態は変えない。判断・承認のシートを開く。承認はフリックだけでは許可しない＝D-53）
 */
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

/** 指示が生まれるときの状態（COO の delegate・リーダーの新しい plan。actor runner） */
export const INITIAL_STATUS: InstructionStatus = "queued";

/**
 * ランナー・システムによる遷移（v1 3.4 ＋ DESIGN-v2 4.4）。from → 許される to。
 * - running → queued: lease 切れ・枠切れでの戻し（v1）
 * - review → running / done → running: reopen（CEO がリーダーと直接話して再開。actor runner）
 * - needs_decision → queued: v1 の回答後の戻し（互換）。needs_decision → running: CEO の回答（actor ceo）
 */
export const SYSTEM_TRANSITIONS: Record<InstructionStatus, readonly InstructionStatus[]> = {
  queued: ["running"],
  running: ["queued", "needs_decision", "review", "failed"],
  needs_decision: ["queued", "running"],
  review: ["running"],
  done: ["running"],
  failed: [],
  canceled: [],
  archived: [],
};

export function canSystemTransition(from: InstructionStatus, to: InstructionStatus): boolean {
  return SYSTEM_TRANSITIONS[from].includes(to);
}

/** reopen できる状態（DESIGN-v2 4.4） */
export const REOPENABLE_STATUSES = ["review", "done"] as const satisfies readonly InstructionStatus[];
export function canReopen(from: InstructionStatus): boolean {
  return (REOPENABLE_STATUSES as readonly InstructionStatus[]).includes(from);
}

/** 遷移の記録の actor（status_transitions.actor） */
export type TransitionActor = "ceo" | "runner" | "system";

/** ホームでの並び（v1 7.3）。archived はホームに出さない */
export const HOME_STATUS_ORDER = [
  "needs_decision",
  "review",
  "running",
  "queued",
  "failed",
  "canceled",
  "done",
] as const satisfies readonly InstructionStatus[];

/** まとまりの見出し（v1 7.11） */
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

/** フリックの下地の文言（v1 7.11） */
export const ACTION_LABELS: Record<CeoAction, string> = {
  approve: "承認",
  send_back: "差し戻し",
  cancel: "取消",
  archive: "アーカイブ",
  retry: "再実行",
  restore: "戻す",
};

/** フリックの下地の色（CSS 変数名。v1 7.6） */
export const ACTION_COLORS: Record<CeoAction | "open_decision", string> = {
  approve: "--accent-success",
  send_back: "--accent-warning",
  cancel: "--accent-danger",
  archive: "--text-tertiary",
  retry: "--accent",
  restore: "--accent",
  open_decision: "--accent-decision",
};

/** 取り消しトーストを出さない操作（v1 3.5。差し戻しはコメントが COO スレッドの発言になるので取り消さない） */
export const NO_UNDO_ACTIONS: readonly CeoAction[] = ["send_back"];

/** 完了・取消を一覧に出す日数（v1 7.3） */
export const RECENT_DAYS_FOR_CLOSED = 7;

// ───────────── まとまりとフリック（DESIGN-v2 13.8） ─────────────

/** displayGroup・swipeActionFor が見る指示の最小の形 */
export type CardLike = { status: InstructionStatus; openDecisionCount: number };

/**
 * 一覧で出すまとまり。開いた判断（承認を含む）があれば running・queued でも「判断待ち」に出す。
 */
export function displayGroup(card: CardLike): InstructionStatus {
  if (card.openDecisionCount > 0 && (card.status === "running" || card.status === "queued")) return "needs_decision";
  return card.status;
}

/**
 * カードのフリックの結果。まとまり（displayGroup）の表で決める。
 * 判断待ちのまとまりの右フリックは判断シートを開くだけ（承認はシートで「許可」）。
 * 状態を変える操作は、本当の状態から nextStatus で動けるときだけ返す（restore は archivedFrom で Worker が決める）。
 */
export function swipeActionFor(card: CardLike, direction: SwipeDirection): SwipeOutcome {
  const outcome = SWIPE_MAP[displayGroup(card)][direction];
  if (outcome === null || outcome === "open_decision" || outcome === "restore") return outcome;
  return nextStatus(card.status, outcome) === null ? null : outcome;
}

// ───────────── エージェントの状態（DESIGN-v2 12.6・13.9） ─────────────

export const AGENT_LIVE_STATES = [
  "idle",
  "queued",
  "running",
  "awaiting_approval",
  "needs_decision",
  "quota_wait",
  "talking",
] as const;
export type AgentLiveState = (typeof AGENT_LIVE_STATES)[number];

/** 組織図の状態の文言（13.9・13.14）。idle は「手すき」、queued は「待機」 */
export const AGENT_STATE_LABELS: Record<AgentLiveState, string> = {
  idle: "手すき",
  queued: "待機",
  running: "実行中",
  awaiting_approval: "承認待ち",
  needs_decision: "判断待ち",
  quota_wait: "枠待ち",
  talking: "話し中",
};

export const SESSION_STATUSES = [
  "pending",
  "running",
  "awaiting_approval",
  "idle",
  "paused",
  "quota_wait",
  "done",
  "failed",
  "canceled",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** セッションの状態の文言（詳細のタブ・13.14 の「状態」から） */
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  pending: "待機",
  running: "実行中",
  awaiting_approval: "承認待ち",
  idle: "手すき",
  paused: "判断待ち",
  quota_wait: "枠待ち",
  done: "完了",
  failed: "失敗",
  canceled: "中断",
};

export type AgentStateInput = {
  /** そのエージェントのセッションの状態（終わったものを含んでよい） */
  sessionStatuses: readonly SessionStatus[];
  /** そのエージェントに開いた判断（承認以外。question・interrupted）がある */
  hasOpenDecision: boolean;
  /** スレッドを持つエージェント（COO・リーダー）のスレッドの状態 */
  threadStatus?: "idle" | "queued" | "running" | null;
  /** リーダーのスレッドで CEO と話し中（CEO の発言の未処理がある・ターンが動いている） */
  talkingWithCeo?: boolean;
};

/**
 * エージェントの状態。優先順は awaiting_approval → 判断待ち → quota_wait → talking → running → queued → idle（12.6）。
 * paused（CEO の回答待ちで止めた）は判断待ちとして扱う。
 */
export function deriveAgentState(input: AgentStateInput): AgentLiveState {
  const s = input.sessionStatuses;
  if (s.includes("awaiting_approval")) return "awaiting_approval";
  if (input.hasOpenDecision || s.includes("paused")) return "needs_decision";
  if (s.includes("quota_wait")) return "quota_wait";
  if (input.talkingWithCeo) return "talking";
  if (s.includes("running") || input.threadStatus === "running") return "running";
  if (s.includes("pending") || input.threadStatus === "queued") return "queued";
  return "idle";
}

// ───────────── プロジェクトの件数（DESIGN-v2 12.6・13.3） ─────────────

export type ProjectCountsValue = {
  running: number;
  queued: number;
  needsDecision: number;
  review: number;
  failed: number;
  doneRecent: number;
};

/**
 * サイドパネルの件数。displayGroup で数える（開いた判断のある running は判断待ち）。
 * doneRecent は完了から RECENT_DAYS_FOR_CLOSED 日以内。canceled・archived は数えない。
 */
export function countInstructions(
  items: readonly (CardLike & { completedAt?: number | null; statusChangedAt?: number })[],
  now: number,
): ProjectCountsValue {
  const counts: ProjectCountsValue = { running: 0, queued: 0, needsDecision: 0, review: 0, failed: 0, doneRecent: 0 };
  const recent = now - RECENT_DAYS_FOR_CLOSED * 24 * 60 * 60 * 1000;
  for (const it of items) {
    switch (displayGroup(it)) {
      case "running":
        counts.running += 1;
        break;
      case "queued":
        counts.queued += 1;
        break;
      case "needs_decision":
        counts.needsDecision += 1;
        break;
      case "review":
        counts.review += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "done": {
        const at = it.completedAt ?? it.statusChangedAt ?? 0;
        if (at >= recent) counts.doneRecent += 1;
        break;
      }
      default:
        break;
    }
  }
  return counts;
}

/** サイドパネルの並び（13.3）: 判断待ち・承認待ち → 確認 → 実行中 → 最終活動の新しい順 */
export function compareSidebarProjects(
  a: { counts: ProjectCountsValue; lastActivityAt: number | null },
  b: { counts: ProjectCountsValue; lastActivityAt: number | null },
): number {
  const rank = (x: { counts: ProjectCountsValue }) =>
    x.counts.needsDecision > 0 ? 0 : x.counts.review > 0 ? 1 : x.counts.running > 0 ? 2 : 3;
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
}

/** サイドパネルで「進行中」に出すか（13.3。その他は折りたたみ） */
export function isProjectInProgress(counts: ProjectCountsValue): boolean {
  return counts.running + counts.queued + counts.needsDecision + counts.review + counts.failed > 0;
}
