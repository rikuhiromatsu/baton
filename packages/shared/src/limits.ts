// 上限値（DESIGN-v2 5.8・8.4・9.2・10・11.6）。ランナーは環境変数で上書きできる。
// v2 で消したもの: v1 の ai*・tokens*・memberTurns・maxCompletionTokens・memberRecent*・fs*・webFetch*（5.8）。

export const LIMITS = {
  // ───── プロセスと並列（5.8・D-64） ─────
  /** claude プロセス: スレッド用（待機中のスレッドのプロセスも数える） */
  threadProcesses: 2,
  /** claude プロセス: メンバー用 */
  memberProcesses: 2,
  /** 指示内のメンバー並列 */
  memberParallel: 2,
  /** スレッドのプロセスを result のあと生かしておく時間（BATON_THREAD_IDLE_MS。5.3） */
  threadIdleMs: 120_000,

  // ───── 1 回の起動（5.8） ─────
  maxTurns: { coo: 20, leader: 30, member: 80 },
  maxBudgetUsd: { coo: 1.5, leader: 2, member: 6 },

  // ───── 1 指示（5.8） ─────
  /** 推定額の合計（超えたら failed「上限に達しました」） */
  instructionCostUsd: 30,
  /** 経過時間（判断待ち・枠待ち・review は数えない） */
  instructionWallClockMs: 180 * 60 * 1000,
  /** 承認の回数 */
  approvalsPerInstruction: 10,
  /** リーダーのやり直しを含めた最大ラウンド（5.5） */
  maxRounds: 2,

  // ───── 承認・ターン（5.8・7.6） ─────
  /** プロセス内で承認を待つ時間（過ぎたら判断待ちに落とす） */
  approvalWaitMs: 10 * 60 * 1000,
  /** ターンの失敗のやり直し回数 */
  turnRetries: 1,
  /** セッションの num_turns 合計がこれを超えたら次のターンから新しいセッション（4.2） */
  sessionTurnsBeforeRotate: 400,
  /** 新しいセッションへの引き継ぎに入れる直近の発言 */
  handoffMessages: 30,
  /** 会話の区切り: CEO の最後の発言からの時間（4.6） */
  conversationBreakMs: 15 * 60 * 1000,

  // ───── 中断・取消（5.7・D-67） ─────
  cancelCloseStdinMs: 2_000,
  cancelSigtermMs: 5_000,
  shutdownGraceMs: 5_000,

  // ───── lease・ハートビート（v1 と同じ） ─────
  leaseMs: 10 * 60 * 1000,
  heartbeatIntervalMs: 30_000,
  /** ランナーがオンラインとみなすハートビートからの時間 */
  runnerOnlineWindowMs: 90_000,
  /** WebSocket が無いときの claim の間隔 */
  claimPollIntervalMs: 15_000,
  /** 承認から確定までの時間（取り消し期限のあと。D-66） */
  finalizeDelayMs: 20_000,

  // ───── 取り消し（v1） ─────
  undoToastMs: 5_000,
  undoServerWindowMs: 15_000,

  // ───── 枠（9.2・D-55） ─────
  quotaFiveHourPause: 0.8,
  quotaSevenDayPause: 0.9,
  /** resetsAt に足す余裕 */
  quotaResumeMarginMs: 60_000,
  /** resetsAt が無いときに待つ時間 */
  quotaFallbackWaitMs: 30 * 60 * 1000,

  // ───── トランスクリプト（8.3・8.4） ─────
  transcriptPerPost: 50,
  transcriptPostBytes: 512 * 1024,
  transcriptFlushMs: 300,
  itemsPerSession: 5_000,
  itemsPerInstruction: 20_000,
  summaryMaxChars: 200,
  summaryPreviewChars: 80,
  bodyTextMaxChars: 32_000,
  bodyThinkingMaxChars: 8_000,
  bodyToolInputMaxChars: 8_000,
  bodyWriteContentMaxChars: 4_000,
  toolResultHeadChars: 6_000,
  toolResultTailChars: 1_500,
  patchMaxLines: 400,
  /** WebSocket で配る body・本文の最大文字数 */
  broadcastMaxChars: 2_000,

  // ───── ストリーミング（4.7） ─────
  streamFlushMs: 100,
  streamDeltaMaxChars: 4_000,

  // ───── 会話（4.3・12.2） ─────
  messageBodyMaxChars: 32_000,
  ceoMessageMaxChars: 8_000,
  messagesPage: 100,
  transcriptPage: 200,
  /** 既読をまとめる時間（4.8） */
  readDebounceMs: 1_000,
  /** トースト（4.8） */
  toastMs: 4_000,

  // ───── 差分（7.4） ─────
  diffPatchMaxChars: 200_000,

  // ───── 通知（10.2） ─────
  pushBatchMs: 15_000,
  pushPayloadMaxBytes: 3_000,
  pushBodyChars: 80,
  pushTtlSec: 86_400,
  pushMaxFailures: 5,

  // ───── 秘書 bot（11.6） ─────
  botCallsPerMinute: 60,
  botSendIntervalMs: 10_000,
  botSendsPerDay: 50,
  botProposalsPerDay: 50,
  botAuditRetentionDays: 90,
  botMessageMaxChars: 2_000,
  botReadLimitMax: 30,
  botReadLimitDefault: 10,

  // ───── v1 から残すもの ─────
  /** 成果物のプレビュー（D1 に置く先頭） */
  artifactPreviewMaxChars: 65_536,
  /** 1 ページの件数（指示の一覧） */
  pageSize: 50,
  /** 一度に作れるタスクの数 */
  tasksPerCreate: 10,
  /** CEO の発言のレート制限（1 分あたり） */
  ceoMessagesPerMinute: 30,
} as const;

export type Limits = typeof LIMITS;
