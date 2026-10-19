// 承認の方針（DESIGN-v2 7.6）。許可ルールで決まらなかった can_use_tool だけがここに来る。
// - 自分の worktree の外への Edit/Write → 拒否
// - ~/projects・~/baton-data の中の Read/Grep/Glob → 許可。それ以外の Read → 拒否
// - 許可リスト外の Bash → CEO に聞く（メンバーだけ。COO・リーダーは拒否）
// - その他 → 拒否
import path from "node:path";
import type { ClaudeRole } from "./permissions.ts";

export type PolicyVerdict = { kind: "allow" } | { kind: "deny"; message: string } | { kind: "ask" };

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function pathOf(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
  const raw =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : typeof input.path === "string"
          ? input.path
          : toolName === "Read" || toolName === "Grep" || toolName === "Glob"
            ? cwd
            : null;
  if (raw === null) return null;
  return path.resolve(cwd, raw);
}

export function decidePermission(input: {
  role: ClaudeRole;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  home: string;
  dataDir: string;
}): PolicyVerdict {
  const { toolName, toolInput, cwd } = input;
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const p = pathOf(toolName, toolInput, cwd);
    if (input.role === "member" && p && inside(cwd, p) && !p.split(path.sep).includes(".git")) return { kind: "allow" };
    return { kind: "deny", message: "自分の作業フォルダ（worktree）の外には書けません" };
  }
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") {
    const p = pathOf(toolName, toolInput, cwd);
    const roots = [path.join(input.home, "projects"), input.dataDir];
    if (p && roots.some((r) => inside(r, p))) return { kind: "allow" };
    return { kind: "deny", message: "その場所は読めません" };
  }
  if (toolName === "Bash") {
    if (input.role === "member") return { kind: "ask" };
    return { kind: "deny", message: "この役割では許可リスト外のコマンドは使えません" };
  }
  return { kind: "deny", message: `${toolName} は使えません` };
}

/** 1 回限りの許可ルール（入力にぴったり合うもの。7.6） */
export function oneTimeRule(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === "Bash" && typeof toolInput.command === "string") return `Bash(${toolInput.command})`;
  if ((toolName === "Edit" || toolName === "Write") && typeof toolInput.file_path === "string") {
    return `Edit(/${toolInput.file_path.startsWith("/") ? toolInput.file_path : `/${toolInput.file_path}`})`;
  }
  return null;
}

/** 承認カードの問い（1,000 文字まで） */
export function approvalQuestion(toolName: string, toolInput: Record<string, unknown>): string {
  const what = toolName === "Bash" && typeof toolInput.command === "string" ? toolInput.command : JSON.stringify(toolInput);
  return `${toolName} を実行してよいですか: ${what}`.slice(0, 1000);
}
