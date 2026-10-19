// e2e・テスト用の台本どおりに答える AI（設計書 8.2・8.2.1）。
// 状態を持たず、messages の文字列だけを見て応答を決める。戻り値は Workers AI の従来形 { response, usage }。
import { AiQuotaError, type AiClient, type AiMessage, type AiRunInput } from "./ai-client.ts";

export const SCRIPTED_SLOW_MS = 1500;
export const SCRIPTED_QUOTA_RETRY_MS = 60_000;

export type ScriptedStage = "coo_route" | "leader_plan" | "member_step" | "leader_review" | "coo_final" | "util";

/** system メッセージ先頭の `ROLE: <stage>` */
export function readStage(messages: AiMessage[]): ScriptedStage | null {
  const system = messages.find((m) => m.role === "system");
  const firstLine = system?.content.trimStart().split("\n", 1)[0] ?? "";
  const m = /^ROLE:\s*([a-z_]+)/.exec(firstLine);
  return (m?.[1] as ScriptedStage | undefined) ?? null;
}

/** 最初の user メッセージの <<<input>>> 〜 <<<end>>> */
export function readInstructionBody(messages: AiMessage[]): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const m = /<<<input>>>\s*([\s\S]*?)\s*<<<end>>>/.exec(user);
  return (m?.[1] ?? user).trim();
}

function readLine(messages: AiMessage[], prefix: string): string | null {
  for (const msg of messages) {
    for (const line of msg.content.split("\n")) {
      const t = line.trim();
      if (t.startsWith(prefix)) return t.slice(prefix.length).trim();
    }
  }
  return null;
}

const hasMarker = (messages: AiMessage[], marker: string) => messages.some((m) => m.content.includes(marker));
const userStartsWith = (messages: AiMessage[], prefix: string) =>
  messages.some((m) => m.role === "user" && m.content.trimStart().startsWith(prefix));

/** 台本の応答（JSON 文字列。[badjson] のときは壊れた JSON） */
export function scriptedResponse(messages: AiMessage[]): string {
  const stage = readStage(messages);
  if (hasMarker(messages, "[badjson]") && !userStartsWith(messages, "JSON_ERROR:")) {
    return '{"kind": "route", "title": "壊れた JSON';
  }
  const body = readInstructionBody(messages);
  const taskKey = readLine(messages, "TASK_KEY:") ?? "t1";
  switch (stage) {
    case "coo_route": {
      if (hasMarker(messages, "[ask]") && readLine(messages, "CEO_ANSWER:") === null) {
        return JSON.stringify({ kind: "ask_ceo", question: "どちらの案で進めますか", options: ["A案", "B案"] });
      }
      return JSON.stringify({
        kind: "route",
        title: Array.from(body).slice(0, 20).join("") || "テスト",
        project: {
          mode: "new",
          name: "テスト",
          slug: "test",
          summary: "テスト用のプロジェクト",
          leader: { name: "リーダー", specialty: "計画とまとめ" },
          members: [
            { name: "調査担当", specialty: "調べもの" },
            { name: "執筆担当", specialty: "文章を書く" },
          ],
        },
        brief: "2 つのタスクに分けて進める",
      });
    }
    case "leader_plan":
      return JSON.stringify({
        kind: "plan",
        tasks: [
          { key: "t1", title: "調べる", spec: "調べて notes/t1.md に書く。完了の条件: ファイルがある", assignee: "調査担当", dependsOn: [] },
          { key: "t2", title: "書く", spec: "まとめて notes/t2.md に書く。完了の条件: ファイルがある", assignee: "執筆担当", dependsOn: [] },
        ],
      });
    case "member_step": {
      if (hasMarker(messages, "[fail]")) return JSON.stringify({ kind: "give_up", reason: "テストのため失敗" });
      const path = `notes/${taskKey}.md`;
      if (userStartsWith(messages, "TOOL_RESULT")) {
        return JSON.stringify({ kind: "done", summary: `${taskKey} を書いた`, artifacts: [{ path, title: `${taskKey} のメモ` }] });
      }
      return JSON.stringify({
        kind: "tool",
        tool: "fs_write",
        args: { path, content: `# ${taskKey}\n\nテストの成果物\n` },
        why: "成果物を書く",
      });
    }
    case "leader_review":
      return JSON.stringify({ kind: "report", summary: "2 つのタスクが終わった", openIssues: [] });
    case "coo_final":
      return JSON.stringify({ kind: "final", report: "テスト報告: すべて完了しました。成果物は notes/ にあります。" });
    default:
      // 補助（util）や不明な段階は短い文章を返す
      return "テスト要約";
  }
}

export class ScriptedAiClient implements AiClient {
  private readonly slowMs: number;
  constructor(slowMs = SCRIPTED_SLOW_MS) {
    this.slowMs = slowMs;
  }

  async chat(_model: string, input: AiRunInput): Promise<unknown> {
    const { messages } = input;
    if (hasMarker(messages, "[slow]")) await new Promise((r) => setTimeout(r, this.slowMs));
    if (hasMarker(messages, "[quota]")) {
      throw new AiQuotaError("scripted quota", Date.now() + SCRIPTED_QUOTA_RETRY_MS);
    }
    const response = scriptedResponse(messages);
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    return {
      response,
      usage: { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: Math.ceil(response.length / 4), total_tokens: 0 },
    };
  }
}
