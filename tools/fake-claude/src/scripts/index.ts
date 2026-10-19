// 台本の選び方: 役割は --append-system-prompt の「ROLE: coo|leader|member」（5.10）、無ければ --json-schema の形から。
import { APPROVAL_COMMAND } from "./member.ts";
import { cooScript } from "./coo.ts";
import { firstLineOf } from "./common.ts";
import { leaderScript } from "./leader.ts";
import { memberScript } from "./member.ts";
import type { Role, Script, TurnContext } from "./types.ts";

export function detectRole(systemPrompt: string | null, schema: Record<string, unknown> | null): Role | null {
  const m = /^ROLE:\s*(coo|leader|member)\b/m.exec(systemPrompt ?? "");
  if (m) return m[1] as Role;
  const props = (schema?.properties ?? null) as Record<string, unknown> | null;
  if (props && "cooReport" in props) return "leader";
  if (props && "actions" in props) return "coo";
  if (props && "kind" in props) return "member";
  if (schema && Array.isArray(schema.oneOf ?? schema.anyOf)) return "member";
  return null;
}

/** 役割が分からないとき: 道具を一通り使う（[tools]）・承認（[approve]）・オウム返し */
function* genericScript(ctx: TurnContext): Script {
  if (ctx.markers.has("tools")) {
    yield { kind: "tool", name: "TodoWrite", input: { todos: [{ content: "道具を一通り使う", status: "in_progress", activeForm: "道具を使っている" }] } };
    yield { kind: "tool", name: "Write", input: { file_path: `${ctx.cwd}/notes.md`, content: "# メモ\n\ngreeting = hello\n" } };
    yield { kind: "tool", name: "Glob", input: { pattern: "**/*.md" } };
    yield { kind: "tool", name: "Read", input: { file_path: `${ctx.cwd}/notes.md` } };
    yield { kind: "tool", name: "Grep", input: { pattern: "greeting", path: ctx.cwd, output_mode: "content", "-n": true } };
    yield { kind: "tool", name: "Edit", input: { file_path: `${ctx.cwd}/notes.md`, old_string: "hello", new_string: "こんにちは", replace_all: false } };
    yield { kind: "tool", name: "Bash", input: { command: "ls", description: "一覧" } };
    yield { kind: "tool", name: "WebSearch", input: { query: "コーヒー 産地" } };
    yield { kind: "tool", name: "WebFetch", input: { url: "https://example.com/", prompt: "要約して" } };
    yield { kind: "tool", name: "TodoWrite", input: { todos: [{ content: "道具を一通り使う", status: "completed", activeForm: "道具を使っている" }] } };
  }
  if (ctx.markers.has("approve")) {
    yield { kind: "tool", name: "Bash", input: { command: APPROVAL_COMMAND, description: "承認の確認用のファイルを書く" } };
  }
  yield { kind: "text", text: `（偽 claude）受け取りました: ${firstLineOf(ctx.input, 200)}` };
}

export function scriptFor(ctx: TurnContext): Script {
  switch (ctx.role) {
    case "coo":
      return cooScript(ctx);
    case "leader":
      return leaderScript(ctx);
    case "member":
      return memberScript(ctx);
    default:
      return genericScript(ctx);
  }
}
