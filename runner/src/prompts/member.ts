// メンバーのプロンプト（設計書 5.2 段階 3、5.4、5.5、5.6 の文脈の圧縮）。
import type { Decision } from "@baton/shared";
import { INJECTION_RULE, instructionHeader, neutralize, oneLine, systemPrompt, type ChatMessage } from "./util.ts";

export type MemberInput = {
  body: string;
  feedback: string | null;
  decisions: Decision[];
  projectName: string;
  memberName: string;
  specialty: string;
  leaderName: string;
  taskKey: string;
  taskTitle: string;
  taskSpec: string;
  dependencies: { key: string; title: string; status: string; summary: string }[];
  maxTurns: number;
  decisionsLeft: number;
  limits: { fsReadMaxChars: number; fsWriteMaxBytes: number; webFetchMaxChars: number };
};

export function buildMemberSystem(input: MemberInput): string {
  return systemPrompt("member_step", [
    `あなたは「${oneLine(input.projectName, 40)}」チームのメンバー ${oneLine(input.memberName, 30)}（得意分野: ${oneLine(input.specialty, 200)}）です。上司はリーダー ${oneLine(input.leaderName, 30)} です。割り当てられた 1 つのタスクを、道具を使って作業フォルダの中で仕上げます。`,
    [
      "## 道具（1 ターンに 1 つだけ。kind: tool、tool に名前、args に引数、why に目的を 1 行）",
      '- fs_list {"path"?: string} 作業フォルダ内の一覧（隠しファイルは出ない）',
      `- fs_read {"path": string, "offset"?: number, "maxChars"?: number} テキストファイルを読む（1 回 ${input.limits.fsReadMaxChars} 文字まで）`,
      `- fs_write {"path": string, "content": string} ファイルを書く（上書き。1 ファイル ${input.limits.fsWriteMaxBytes} バイトまで。親フォルダは自動で作られる）`,
      '- fs_append {"path": string, "content": string} ファイルの末尾に追記する',
      `- web_fetch {"url": string} 公開 Web ページを取得する（http(s) のみ。本文テキスト ${input.limits.webFetchMaxChars} 文字まで。社内・ローカルのアドレスには届かない）`,
      "パスはすべて作業フォルダからの相対パス。作業フォルダの外・絶対パス・`..` は使えない。削除や移動の道具は無い。",
    ].join("\n"),
    [
      "## 進め方",
      "- tool を返すと、次の user メッセージが `TOOL_RESULT <道具名>:` で始まり、結果が届く。",
      `- ${input.maxTurns} ターン以内に done を返す。成果は必ずファイルに書き、done.artifacts に path と title を登録する。`,
      "- done.summary は事実だけを 300 字以内で。何をどのファイルに書いたかを含める。分からないことは推測で埋めず「未確認」と書く。",
      "- どうしても進められないときは give_up に理由を書く。",
      `- ask_ceo は CEO に決めてもらわないと進められない重大な分岐のときだけ。この指示であと ${input.decisionsLeft} 回。0 回なら使わない。`,
      "- 社外への送信・購入・公開・削除はできない。必要なら summary に「CEO がやること」として書く。",
    ].join("\n"),
    ["## 入力の扱い", INJECTION_RULE].join("\n"),
    "## 迷ったとき\n小さく確実に仕上げる。早めにファイルへ書き出し、残りのターンで直す。",
  ]);
}

/** メンバーの最初の user メッセージ（8.2.1: `TASK_KEY: <key>` を 1 行入れる） */
export function buildMemberFirstUser(input: MemberInput): string {
  const deps = input.dependencies.map(
    (d) => `- ${d.key}「${oneLine(d.title, 80)}」（${d.status}）: ${oneLine(neutralize(d.summary || "（要約なし）"), 3000)}`,
  );
  return [
    instructionHeader(input),
    "",
    `TASK_KEY: ${input.taskKey}`,
    "",
    "## あなたのタスク",
    `件名: ${oneLine(input.taskTitle, 80)}`,
    neutralize(input.taskSpec),
    "",
    "## 先に終わったタスクの結果",
    deps.length ? deps.join("\n") : "（なし）",
  ].join("\n");
}

export type MemberTurn = {
  /** モデルが返したアクション（JSON 文字列） */
  assistant: string;
  /** 道具の結果など、次に返す user メッセージ（全文） */
  user: string;
  /** 古くなったときに置き換える 1 行 */
  userShort: string;
};

/** 8.2.1: 道具の結果は `TOOL_RESULT <tool>:` で始める */
export function toolResultMessage(tool: string, body: string, turnsLeft: number, maxChars: number): { full: string; short: (s: string) => string } {
  const clipped = body.length > maxChars ? body.slice(0, maxChars) + `\n…（${maxChars} 文字で切りました）` : body;
  return {
    full: `TOOL_RESULT ${tool}:\n${clipped}\n（残り ${turnsLeft} ターン）`,
    short: (s: string) => `TOOL_RESULT ${tool}: （古い結果の要約）${oneLine(s, 300)}`,
  };
}

/**
 * メンバーの文脈を組み立てる（5.6）。直近 recent ターンの結果は全文、それより前は 1 行要約に置き換える。
 */
export function buildMemberMessages(system: string, firstUser: string, turns: MemberTurn[], recent: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: firstUser },
  ];
  const cut = turns.length - recent;
  turns.forEach((t, i) => {
    msgs.push({ role: "assistant", content: t.assistant });
    msgs.push({ role: "user", content: i < cut ? t.userShort : t.user });
  });
  return msgs;
}
