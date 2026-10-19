// 上限値（設計書 5.6）。ランナーは環境変数で上書きできる。

export const LIMITS = {
  /** ランナーが同時に実行する指示の数 */
  runnerConcurrentInstructions: 2,
  /** 指示内のメンバー並列 */
  memberParallel: 3,
  /** ランナー全体の AI 同時呼び出し */
  aiConcurrent: 4,
  /** 1 指示あたりの AI 呼び出し回数 */
  aiCallsPerInstruction: 60,
  /** 1 指示あたりのトークン（入力＋出力） */
  tokensPerInstruction: 400_000,
  /** 1 日あたりのトークン（全体、UTC） */
  tokensPerDay: 2_000_000,
  /** メンバーの 1 タスクのターン */
  memberTurns: 12,
  /** リーダーのやり直しを含めた最大ラウンド */
  maxRounds: 2,
  /** 1 指示の経過時間（ミリ秒） */
  instructionWallClockMs: 30 * 60 * 1000,
  /** 1 回の AI 呼び出しのタイムアウト（ランナー側、ミリ秒） */
  aiCallTimeoutMs: 120_000,
  /** 役割ごとの最大出力トークン */
  maxCompletionTokens: { coo: 2048, leader: 2048, member: 4096, util: 512 },
  /** メンバーの文脈に全文で残す直近ターン数と、1 結果の最大文字数 */
  memberRecentTurns: 6,
  memberToolResultChars: 8000,
  /** 1 指示あたりの CEO への判断 */
  decisionsPerInstruction: 3,
  /** lease（ミリ秒）とハートビート間隔 */
  leaseMs: 10 * 60 * 1000,
  heartbeatIntervalMs: 30_000,
  /** ランナーがオンラインとみなすハートビートからの時間 */
  runnerOnlineWindowMs: 90_000,
  /** WebSocket が無いときの claim の間隔 */
  claimPollIntervalMs: 15_000,
  /** 取り消し: トースト表示とサーバーの受付期限 */
  undoToastMs: 5_000,
  undoServerWindowMs: 15_000,
  /** 道具 */
  fsReadMaxChars: 20_000,
  fsListMax: 500,
  fsWriteMaxBytes: 1024 * 1024,
  fsWritesPerInstruction: 50,
  fsWriteTotalBytesPerInstruction: 20 * 1024 * 1024,
  webFetchTimeoutMs: 15_000,
  webFetchMaxBytes: 2 * 1024 * 1024,
  webFetchMaxChars: 20_000,
  webFetchMaxRedirects: 3,
  webFetchPerInstruction: 30,
  /** D1 に残すイベント content の最大文字数、WebSocket で配る最大文字数 */
  eventContentMaxChars: 16_000,
  eventBroadcastMaxChars: 2_000,
  /** 成果物のプレビュー（D1 に置く先頭） */
  artifactPreviewMaxChars: 65_536,
  /** 1 ページの件数 */
  pageSize: 50,
  /** 指示作成のレート制限（1 分あたり） */
  createInstructionPerMinute: 30,
  /** 一度に送れるイベント・タスクの数 */
  eventsPerAppend: 50,
  tasksPerCreate: 10,
} as const;

export type Limits = typeof LIMITS;
