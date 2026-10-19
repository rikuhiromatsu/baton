// 許可・拒否のルール（DESIGN-v2 1.3・7.2）を簡易に当てる。
// - 評価は deny → allow。Bash は &&・||・;・| で区切った部分ごと（deny はどれか 1 つ、allow は全部）。
// - Bash(<前方一致> *)・Bash(<前方一致>:*)・Bash(<全文>)。
// - Edit(...) は Write・NotebookEdit にも効く。パスは gitignore 形式: `//` 始まりは絶対パス、`/` 始まりは cwd から、`~/` はホーム、それ以外はどこでも。
// - WebFetch(domain:<host>)。
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Rule = { tool: string; content: string | null };

export function parseRule(text: string): Rule {
  const m = /^([A-Za-z0-9_:.-]+)\((.*)\)$/s.exec(text.trim());
  if (m) return { tool: m[1]!, content: m[2]! };
  return { tool: text.trim(), content: null };
}

const EDIT_FAMILY = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_FAMILY = new Set(["Read", "Grep", "Glob"]);

function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
  if (ruleTool === "Edit" && EDIT_FAMILY.has(toolName)) return true;
  return false;
}

/** Bash のコマンドを区切りで分ける（引用符の中は切らない、簡易） */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function bashPatternMatches(pattern: string, command: string): boolean {
  const cmd = command.trim();
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -2);
    return cmd === prefix || cmd.startsWith(`${prefix} `);
  }
  if (pattern.endsWith("*")) return cmd.startsWith(pattern.slice(0, -1));
  return cmd === pattern;
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // **/ は 0 個以上のフォルダ
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * ルールの固定部分（最初のワイルドカードより前のフォルダ）をシンボリックリンクの先に直す。
 * macOS の /var → /private/var のように、cwd（realpath）とルールの書き方がずれても当たるように。
 */
function realPrefix(pattern: string): string {
  const firstWild = pattern.search(/[*?[]/);
  const fixed = firstWild < 0 ? pattern : pattern.slice(0, firstWild);
  const dir = fixed.endsWith("/") ? fixed.slice(0, -1) : path.dirname(fixed);
  try {
    const real = realpathSync(dir);
    return real === dir ? pattern : real + pattern.slice(dir.length);
  } catch {
    return pattern;
  }
}

/** まだ無いファイルでも、ある祖先までをリンクの先に直した絶対パス */
export function realFile(abs: string): string {
  let dir = abs;
  const rest: string[] = [];
  while (dir !== path.dirname(dir)) {
    try {
      return path.join(realpathSync(dir), ...rest);
    } catch {
      rest.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
  return abs;
}

/** パスのルールが絶対パス file に当たるか */
export function pathPatternMatches(pattern: string, file: string, cwd: string): boolean {
  const abs = realFile(path.resolve(cwd, file));
  let base: string | null;
  let rest: string;
  if (pattern.startsWith("//")) {
    base = "/";
    rest = pattern.slice(2);
  } else if (pattern.startsWith("~/")) {
    base = os.homedir();
    rest = pattern.slice(2);
  } else if (pattern.startsWith("/")) {
    base = cwd;
    rest = pattern.slice(1);
  } else {
    base = null;
    rest = pattern;
  }
  if (base !== null) {
    const full = realPrefix(path.join(base, rest));
    // フォルダそのものも「/**」で当てる
    if (full.endsWith("/**") && abs === full.slice(0, -3)) return true;
    return globToRegex(full).test(abs);
  }
  // どこでも（gitignore の相対）
  const re = globToRegex(rest.includes("/") ? rest : `**/${rest}`);
  return re.test(abs.slice(1)) || re.test(abs);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 1 つのルールが道具の呼び出しに当たるか */
export function ruleMatches(rule: Rule, toolName: string, input: Record<string, unknown>, cwd: string, mode: "allow" | "deny"): boolean {
  if (!toolMatches(rule.tool, toolName)) return false;
  if (rule.content === null || rule.content === "" || rule.content === "*") return true;
  const c = rule.content;
  if (toolName === "Bash") {
    const parts = splitCommand(String(input.command ?? ""));
    if (parts.length === 0) return false;
    return mode === "deny" ? parts.some((p) => bashPatternMatches(c, p)) : parts.every((p) => bashPatternMatches(c, p));
  }
  if (EDIT_FAMILY.has(toolName) || READ_FAMILY.has(toolName)) {
    const file = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    if (!file) return false;
    return pathPatternMatches(c, file, cwd);
  }
  if (toolName === "WebFetch") {
    const m = /^domain:(.+)$/.exec(c);
    return m ? hostOf(String(input.url ?? "")) === m[1] : false;
  }
  return false;
}

/** Bash の allow は「部分ごとにどれかのルール」に当たればよい */
function bashAllowed(rules: readonly Rule[], input: Record<string, unknown>): boolean {
  const parts = splitCommand(String(input.command ?? ""));
  if (parts.length === 0) return false;
  return parts.every((p) => rules.some((r) => r.tool === "Bash" && (r.content === null || r.content === "" || bashPatternMatches(r.content, p))));
}

export type PermissionContext = {
  cwd: string;
  addDirs: readonly string[];
  allow: readonly Rule[];
  deny: readonly Rule[];
  mode: string;
};

export type Verdict = { kind: "allow" } | { kind: "deny"; rule: string } | { kind: "ask" };

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 道具の呼び出しの判定（承認を出すかどうかは呼び出し側が --permission-prompt-tool で決める） */
export function evaluatePermission(ctx: PermissionContext, toolName: string, input: Record<string, unknown>): Verdict {
  for (const r of ctx.deny) {
    if (ruleMatches(r, toolName, input, ctx.cwd, "deny")) return { kind: "deny", rule: r.content === null ? r.tool : `${r.tool}(${r.content})` };
  }
  if (toolName === "StructuredOutput" || toolName === "TodoWrite") return { kind: "allow" };
  if (ctx.mode === "bypassPermissions") return { kind: "allow" };
  if (toolName === "Bash" ? bashAllowed(ctx.allow, input) : ctx.allow.some((r) => ruleMatches(r, toolName, input, ctx.cwd, "allow"))) return { kind: "allow" };
  const roots = [ctx.cwd, ...ctx.addDirs.map((d) => realFile(path.resolve(ctx.cwd, d)))];
  const target = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
  const targetAbs = target ? realFile(path.resolve(ctx.cwd, target)) : null;
  // 読み取りは作業フォルダ（と --add-dir）の中なら許可なしで動く（1.3）
  if (READ_FAMILY.has(toolName) && (targetAbs === null || roots.some((r) => inside(r, targetAbs)))) return { kind: "allow" };
  if (ctx.mode === "acceptEdits" && EDIT_FAMILY.has(toolName) && targetAbs !== null && roots.some((r) => inside(r, targetAbs))) return { kind: "allow" };
  return { kind: "ask" };
}
