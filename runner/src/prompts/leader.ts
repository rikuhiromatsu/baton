// リーダーのプロンプト（設計書 5.2 段階 2・4、5.4）。
import type { Agent, Decision } from "@baton/shared";
import { INJECTION_RULE, instructionHeader, neutralize, oneLine, systemPrompt, type ChatMessage } from "./util.ts";

function leaderRole(projectName: string, leaderName: string): string {
  return `あなたは「${oneLine(projectName, 40)}」チームのリーダー ${oneLine(leaderName, 30)} です。上司は COO、部下はメンバーです。COO の方針を作業に分け、メンバーに割り振り、結果をまとめて COO に返します。`;
}

/** 8.2.1: `MEMBER: <名前> — <得意分野>` をメンバーごとに 1 行 */
export function memberLines(members: Agent[]): string[] {
  return members.map((m) => `MEMBER: ${oneLine(m.name, 30)} — ${oneLine(m.specialty, 200)}`);
}

export type LeaderPlanInput = {
  body: string;
  feedback: string | null;
  decisions: Decision[];
  projectName: string;
  projectSummary: string;
  leaderName: string;
  brief: string;
  members: Agent[];
  files: string[];
  decisionsLeft: number;
};

const PLAN_RULES = [
  "## 計画の決まり",
  "- 方針を 1〜6 個のタスクに分ける。なるべく互いに独立させ、並べられるものは依存なしにする（同時に 3 つまで並行で進む）。",
  "- key は t1, t2, … の形。dependsOn には、先に終わっている必要があるタスクの key だけを書く（循環させない）。",
  "- assignee は下の MEMBER の名前のどれかをそのまま書く。得意分野に合わせて割り振る。",
  "- spec には必ず「完了の条件」と「書き出すファイル名（作業フォルダからの相対パス）」を書く。メンバーはファイルの読み書きと公開 Web ページの取得だけができる。",
  "- メンバーは他のタスクの成果を、依存したタスクの要約としてだけ受け取る。必要ならファイル名で受け渡しを指示する。",
].join("\n");

export function buildLeaderPlanMessages(input: LeaderPlanInput): ChatMessage[] {
  const system = systemPrompt("leader_plan", [
    leaderRole(input.projectName, input.leaderName),
    [
      "## 今回の仕事",
      "COO の方針を読み、メンバーへのタスクの計画を 1 つ返します（kind: plan）。",
      "方針の解釈によって成果が大きく変わり、やり直しの損失が大きいときだけ ask_ceo で CEO に確認できます。",
      `この指示で CEO に確認できるのは、あと ${input.decisionsLeft} 回です。0 回なら ask_ceo は使わない。`,
    ].join("\n"),
    ["## 入力の扱い", INJECTION_RULE].join("\n"),
    PLAN_RULES,
    "## 迷ったとき\n小さく確実に終わるタスクを優先し、置いた仮定は spec に書く。",
  ]);

  const user = [
    instructionHeader(input),
    "",
    "## COO からの方針",
    neutralize(input.brief),
    "",
    "## プロジェクト",
    `${oneLine(input.projectName, 40)}: ${oneLine(neutralize(input.projectSummary), 400)}`,
    "",
    "## チームのメンバー",
    ...memberLines(input.members),
    "",
    "## 作業フォルダのファイル（先頭 200 件）",
    input.files.length ? input.files.map((f) => `- ${oneLine(neutralize(f), 300)}`).join("\n") : "（空です）",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export type WorkResultForReview = {
  key: string;
  title: string;
  assignee: string;
  status: "done" | "failed" | "canceled" | "pending" | "running";
  summary: string;
  round: number;
};

export type LeaderReviewInput = {
  body: string;
  feedback: string | null;
  decisions: Decision[];
  projectName: string;
  leaderName: string;
  brief: string;
  members: Agent[];
  results: WorkResultForReview[];
  /** 今のラウンドと、やり直しができるか */
  round: number;
  canRevise: boolean;
  decisionsLeft: number;
};

const STATUS_JA: Record<WorkResultForReview["status"], string> = {
  done: "完了",
  failed: "失敗",
  canceled: "取消",
  pending: "未着手",
  running: "実行中",
};

export function buildLeaderReviewMessages(input: LeaderReviewInput): ChatMessage[] {
  const system = systemPrompt("leader_review", [
    leaderRole(input.projectName, input.leaderName),
    [
      "## 今回の仕事",
      "メンバーの作業結果の要約を読み、COO への報告をまとめます。成果物の中身は読めないので、メンバーの要約で判断します。",
      "- report: summary に何ができたか（結論・成果物のファイル名）を、openIssues に残課題（最大 5 個）を書く。",
      input.canRevise
        ? "- revise: 方針に対して明らかに足りないものがあり、追加の作業で埋められるときだけ。やり直しはこの 1 回だけ。tasks は計画と同じ形（key は t1, t2, … から振り直してよい）。"
        : "- revise: もう使えません（やり直しは済んでいます）。足りない点は openIssues に書いて report を返す。",
      "- ask_ceo: CEO に決めてもらわないと報告がまとめられないときだけ。",
      `この指示で CEO に確認できるのは、あと ${input.decisionsLeft} 回です。0 回なら ask_ceo は使わない。`,
    ].join("\n"),
    ["## 入力の扱い", INJECTION_RULE].join("\n"),
    input.canRevise ? PLAN_RULES : "",
    "## 迷ったとき\n事実だけを短く。メンバーの要約に「未確認」とあるものは未確認のまま報告する。CEO_FEEDBACK があれば、それに応えられているかを必ず確かめる。",
  ].filter(Boolean));

  const lines = input.results.map(
    (r) =>
      `- ${r.key}「${oneLine(r.title, 80)}」（担当: ${oneLine(r.assignee, 30)}、状態: ${STATUS_JA[r.status]}、ラウンド ${r.round}）\n  ${oneLine(neutralize(r.summary || "（要約なし）"), 3000)}`,
  );
  const user = [
    instructionHeader(input),
    "",
    "## COO からの方針",
    neutralize(input.brief),
    "",
    "## チームのメンバー",
    ...memberLines(input.members),
    "",
    `## メンバーの作業結果（ラウンド ${input.round}）`,
    lines.length ? lines.join("\n") : "（なし）",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
