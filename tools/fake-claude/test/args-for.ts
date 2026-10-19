// ランナーが組み立てるのと同じ形の引数（DESIGN-v2 6.1・7.2）。テスト用の簡易版。
import { turnJsonSchema, type TurnRole } from "@baton/shared";
import { COMMON_ARGS } from "./helpers.ts";

export const MEMBER_ALLOW = (ws: string) => [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookEdit",
  `Edit(/${ws}/**)`,
  "Bash(npm test)",
  "Bash(npm test *)",
  "Bash(node *)",
  "Bash(mkdir *)",
  "Bash(touch *)",
  "Bash(git status *)",
  "Bash(git diff *)",
];

export const COMMON_DENY = ["Bash(rm *)", "Bash(git push *)", "Bash(git commit *)", "Bash(curl *)", "Read(~/.ssh/**)", "Edit(~/.claude/**)", "AskUserQuestion", "Agent", "Task"];

export function roleArgs(
  role: TurnRole,
  opts: { session: { id: string; resume: boolean }; cwd: string; stream?: boolean; extra?: string[] },
): string[] {
  const tools =
    role === "coo"
      ? "Read,Grep,Glob,WebFetch,WebSearch"
      : role === "leader"
        ? "Read,Grep,Glob,Bash,WebFetch,WebSearch,TodoWrite"
        : "Read,Grep,Glob,Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,TodoWrite";
  const allow =
    role === "member"
      ? MEMBER_ALLOW(opts.cwd)
      : role === "coo"
        ? ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]
        : ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite", "Bash(git log *)", "Bash(git diff *)"];
  return [
    ...COMMON_ARGS,
    ...(opts.stream === false ? [] : ["--input-format", "stream-json"]),
    ...(role === "member" ? [] : ["--include-partial-messages"]),
    "--model",
    role === "coo" ? "opus" : "sonnet",
    ...(opts.session.resume ? ["--resume", opts.session.id] : ["--session-id", opts.session.id]),
    "--permission-mode",
    "manual",
    "--permission-prompt-tool",
    "stdio",
    "--tools",
    tools,
    "--allowedTools",
    ...allow,
    "--disallowedTools",
    ...COMMON_DENY,
    "--append-system-prompt",
    `ROLE: ${role}\nあなたは Baton の${role}。`,
    "--json-schema",
    JSON.stringify(turnJsonSchema(role)),
    "--max-turns",
    role === "member" ? "80" : "20",
    ...(opts.extra ?? []),
  ];
}
