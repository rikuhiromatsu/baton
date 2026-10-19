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
  menuGuide: "使い方",
  onboardingNext: "次へ",
  onboardingBack: "戻る",
  onboardingStart: "はじめる",
  onboardingSkip: "スキップ",
} as const;

/** 初回の案内（D-38）。最初のログイン時とメニューの「使い方」で出す */
export const ONBOARDING_STEPS = [
  { title: "指示を出す", body: "下の入力欄に、やってほしいことを書いて送ります。受け取るのは AI の COO です。" },
  { title: "チームが動く", body: "COO がプロジェクトとチームを決め、リーダーが作業を分け、メンバーが Mac mini で進めます。青い点が点滅している間は実行中です。" },
  { title: "報告を確かめる", body: "終わると「確認」に届きます。カードをタップすると、報告・タスク・成果物を開けます。" },
  { title: "フリックで決める", body: "右へフリックで承認、左で差し戻し。紫の「判断待ち」は右へフリックで回答します。5 秒間は「元に戻す」で取り消せます。" },
  { title: "いつでも見直せる", body: "右上のアイコンから、プロジェクト・アーカイブ・使用量と、この案内を開けます。" },
] as const;

/** 画面に出てよい固定文言の全集合（AI が生成した文章と利用者の入力は対象外） */
export const ALLOWED_FIXED_TEXTS: readonly string[] = [
  ...Object.values(UI_TEXT),
  ...Object.values(STATUS_LABELS),
  ...Object.values(ACTION_LABELS),
  ...ONBOARDING_STEPS.flatMap((s) => [s.title, s.body]),
  "Baton",
];
