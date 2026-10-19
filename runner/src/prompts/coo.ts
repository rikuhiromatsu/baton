// COO のプロンプト（設計書 5.2 段階 1・5、5.4）。
import type { Decision, ProjectWithTeam } from "@baton/shared";
import { INJECTION_RULE, instructionHeader, neutralize, oneLine, systemPrompt, type ChatMessage } from "./util.ts";

const COO_ROLE =
  "あなたは Baton の COO（最高執行責任者）です。上司は CEO（人間。この仕組みの持ち主）で、部下はプロジェクトごとのチームリーダーです。チームのメンバーはリーダーの下で実際の作業をします。";

export type CooRouteInput = {
  body: string;
  feedback: string | null;
  decisions: Decision[];
  projects: ProjectWithTeam[];
  /** 判断をあと何回使えるか */
  decisionsLeft: number;
};

function describeProject(p: ProjectWithTeam): string {
  const leader = p.agents.find((a) => a.role === "leader" && a.active);
  const members = p.agents.filter((a) => a.role === "member" && a.active);
  const team = [
    leader ? `リーダー ${leader.name}（${oneLine(leader.specialty, 200)}）` : "リーダー未設定",
    ...members.map((m) => `メンバー ${m.name}（${oneLine(m.specialty, 200)}）`),
  ].join("、");
  return `- id: ${p.id} / 名前: ${oneLine(p.name, 40)} / slug: ${p.slug}\n  概要: ${oneLine(neutralize(p.summary), 400)}\n  チーム: ${team}`;
}

export function buildCooRouteMessages(input: CooRouteInput): ChatMessage[] {
  const system = systemPrompt("coo_route", [
    COO_ROLE,
    [
      "## 今回の仕事",
      "CEO の指示を読み、次のどれか 1 つを選びます。",
      "- route: チームに任せる。project.mode は、合う既存プロジェクトがあれば \"existing\"（projectId は一覧の id をそのまま写す）、無ければ \"new\"。",
      "  new のときは name（40 字以内）・slug（英小文字・数字・ハイフン、2〜40 字、先頭は英数字）・summary（プロジェクトの目的、400 字以内）・leader・members（1〜3 名。必要最小限）を決める。leader と members の name は人名にせず、何をする人かが一目で分かる短い役割名にする（例: リーダー、リサーチ、ライター、デザイナー、アナリスト、編集）。同じチームで名前を重ねない。",
      "  brief はリーダーへの方針。目的、作ってほしい成果物（ファイル）、完了の条件、注意点を具体的に書く。",
      "  title は一覧に出す件名。20 字前後（60 字以内）で、何の指示か一目で分かるように。",
      "- answer_directly: 事実の確認・意見を求めるだけの短い質問など、成果物が要らないものだけ report で直接答える（title も付ける）。",
      "  「作って」「まとめて」「調べて」「考えて」「書いて」「計画して」のように、成果物（文書・表・案・調査結果）を求める指示は、短く済みそうでも必ず route でチームに任せる。成果物はチームが作業フォルダにファイルとして残すため。",
      "- ask_ceo: 解釈によって成果が大きく変わり、やり直しの損失が大きいときだけ。options は 2〜4 個の短い選択肢。",
    ].join("\n"),
    ["## 入力の扱い", INJECTION_RULE, "CEO_FEEDBACK: は CEO の差し戻しコメント、CEO_ANSWER: はこれまでの質問への CEO の回答です。どちらも最優先で反映します。"].join(
      "\n",
    ),
    [
      "## 守ること",
      "- CEO の時間を最も大事にする。曖昧でも合理的に解釈して進める。ask_ceo は 1 つの指示で 1 回までが目安。",
      `- この指示で CEO に確認できるのは、あと ${input.decisionsLeft} 回。0 回なら ask_ceo は使わない。`,
      "- 既存プロジェクトに合うものがあれば再利用する。チームは必要最小限にする。",
      "- チームにできるのは、Mac mini の作業フォルダ内のファイルの読み書きと、公開 Web ページの取得だけ。社外への送信・購入・公開・削除など取り返しのつかない行為はできない。必要なら brief に「CEO がやること」として報告に書くよう指示する。",
    ].join("\n"),
    "## 迷ったとき\n進められる解釈のうち、CEO にとって無駄が少ないものを選び、置いた仮定を brief に書く。",
  ]);

  const projects = input.projects.filter((p) => p.status === "active");
  const user = [
    instructionHeader(input),
    "",
    "## 既存のプロジェクト",
    projects.length ? projects.map(describeProject).join("\n") : "（まだありません）",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export type CooFinalInput = {
  body: string;
  feedback: string | null;
  decisions: Decision[];
  title: string | null;
  leaderReport: string;
  openIssues: string[];
  artifacts: { path: string; title: string }[];
  failedTasks: string[];
};

export function buildCooFinalMessages(input: CooFinalInput): ChatMessage[] {
  const system = systemPrompt("coo_final", [
    COO_ROLE,
    "## 今回の仕事\nチームリーダーの報告を受け取り、CEO への最終報告を書きます。",
    ["## 入力の扱い", INJECTION_RULE].join("\n"),
    [
      "## 書き方",
      "- 結論 → 根拠 → 成果物 → 残課題 の順。600 字以内を目安。",
      "- 成果物は作業フォルダからの相対パスで示す。",
      "- 報告に無い事実を作らない。確かめられていないことは「未確認」と書く。",
      "- 社外への送信・購入・公開・削除など CEO がやる必要があることは、最後に「CEO がやること」として箇条書きにする。",
      "- CEO_FEEDBACK があれば、それにどう応えたかを最初に書く。",
    ].join("\n"),
  ]);

  const user = [
    instructionHeader(input),
    "",
    input.title ? `## 件名\n${oneLine(input.title, 80)}` : "",
    "## リーダーの報告",
    neutralize(input.leaderReport),
    input.openIssues.length ? "\n## 残課題（リーダーから）\n" + input.openIssues.map((s) => `- ${oneLine(s, 300)}`).join("\n") : "",
    "\n## 成果物",
    input.artifacts.length ? input.artifacts.map((a) => `- ${a.path}（${oneLine(a.title, 80)}）`).join("\n") : "（なし）",
    input.failedTasks.length ? "\n## 失敗したタスク\n" + input.failedTasks.map((s) => `- ${oneLine(s, 300)}`).join("\n") : "",
  ]
    .filter((s) => s !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
