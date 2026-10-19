// モックの中のデータの形（D1 の代わりにメモリに持つ）
import type {
  AgentSessionSummary,
  Artifact,
  Decision,
  InstructionStatus,
  InstructionSummary,
  Task,
  ThreadMessage,
  ThreadSummary,
  TranscriptItem,
  Workspace,
} from "@baton/shared";

export type ThreadRec = {
  summary: Omit<ThreadSummary, "unread" | "lastSeq" | "lastReadSeq" | "lastMessage">;
  messages: ThreadMessage[];
  lastReadSeq: number;
};

export type InstRec = {
  summary: InstructionSummary;
  feedback: string | null;
  attempt: number;
  archivedFrom: InstructionStatus | null;
  originThreadId: string | null;
  originMessageId: string | null;
  finalizedAt: number | null;
  tasks: Task[];
  decisions: Decision[];
  artifacts: Artifact[];
  sessions: AgentSessionSummary[];
  workspaces: Workspace[];
  patch: string | null;
  reviewSummary: string | null;
};

export type TranscriptStore = Map<string, TranscriptItem[]>;

export type MockOptions = {
  /** 未ログインから始める */
  loggedOut?: boolean;
  /** シミュレーションの速さ（1 = 標準。テストでは大きくする） */
  speed?: number;
  /** 種データを入れない */
  empty?: boolean;
  /** 一覧の応答を遅らせる（スケルトンの確認用。ミリ秒） */
  listDelayMs?: number;
  /** シナリオ A を最初から再生する（COO の会話は空から） */
  scenario?: "a" | null;
  /** 種データの中で動いている作業を進めない（スクリーンショット・テスト用） */
  still?: boolean;
  now?: () => number;
};
