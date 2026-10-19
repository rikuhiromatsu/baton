// 画面に出してよい固定文言（設計書 7.11）。これ以外の固定文言は置かない。F7 のテストがこの一覧で検査する。
import { ACTION_LABELS, STATUS_LABELS } from "./status.ts";

export const UI_TEXT = {
  loginGoogle: "Google でログイン",
  loginForbidden: "このアカウントでは使えません",
  loginFailed: "ログインできませんでした",
  composerAria: "COO への指示",
  sendAria: "送信",
  sectionReport: "報告",
  sectionDecision: "判断",
  sectionTasks: "タスク",
  sectionArtifacts: "成果物",
  sectionLog: "ログ",
  sectionRawLog: "生ログ",
  answerAria: "回答",
  answerSubmit: "回答する",
  sendBackSubmit: "差し戻す",
  commentAria: "コメント",
  openOnMini: "Mac mini で開く",
  undo: "元に戻す",
  sendFailed: "送信できませんでした",
  resend: "再送",
  updateFailed: "更新できませんでした",
  menuProjects: "プロジェクト",
  menuArchive: "アーカイブ",
  menuUsage: "使用量",
  menuLogout: "ログアウト",
  reload: "再読み込み",
  limitReached: "上限に達しました",
  close: "閉じる",
} as const;

/** 画面に出てよい固定文言の全集合（AI が生成した文章と利用者の入力は対象外） */
export const ALLOWED_FIXED_TEXTS: readonly string[] = [
  ...Object.values(UI_TEXT),
  ...Object.values(STATUS_LABELS),
  ...Object.values(ACTION_LABELS),
  "Baton",
];
