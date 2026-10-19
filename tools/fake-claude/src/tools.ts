// 道具の実行。Read・Write・Edit・Bash・Glob・Grep・TodoWrite は cwd の中で本当に動く（worktree の統合をランナーが試せるように）。
// WebFetch・WebSearch・Skill は通信せずに定型の結果を返す。結果の形（content と tool_use_result）は実物の記録に合わせる。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Todo } from "./store.ts";

export type ToolOutcome = { content: string; isError: boolean; toolUseResult: unknown };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const err = (message: string): ToolOutcome => ({ content: `<tool_use_error>${message}</tool_use_error>`, isError: true, toolUseResult: `Error: ${message}` });

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/** 前後の共通部分を除いた 1 つの塊（前後 3 行の文脈つき）。実物の structuredPatch と同じ形 */
export function simplePatch(before: string, after: string): Hunk[] {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  if (before === after) return [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length - 1, endA + ctx);
  const toB = Math.min(b.length - 1, endB + ctx);
  const lines: string[] = [];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i]}`);
  return [{ oldStart: from + 1, oldLines: toA - from + 1, newStart: from + 1, newLines: toB - from + 1, lines }];
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** cwd の下のファイルを相対パスで（.git と node_modules を除く、2,000 件まで） */
export function walkFiles(root: string, limit = 2000): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= limit) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) out.push(path.relative(root, full));
    }
  };
  visit(root);
  return out;
}

function globRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export type ToolEnv = { cwd: string; todos: Todo[]; setTodos: (t: Todo[]) => void; env: NodeJS.ProcessEnv };

export function runTool(name: string, input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  try {
    switch (name) {
      case "Read":
        return read(input, t);
      case "Write":
        return write(input, t);
      case "Edit":
        return edit(input, t);
      case "Bash":
        return bash(input, t);
      case "Glob":
        return glob(input, t);
      case "Grep":
        return grep(input, t);
      case "TodoWrite":
        return todoWrite(input, t);
      case "WebFetch": {
        const url = str(input.url);
        const result = `（偽 claude）${url} の内容の要約です。`;
        return { content: result, isError: false, toolUseResult: { bytes: 1024, code: 200, codeText: "OK", result, durationMs: 5, url } };
      }
      case "WebSearch": {
        const query = str(input.query);
        const content = `Web search results for query: "${query}"\n\n1. （偽 claude）${query} の解説 — https://example.com/a\n2. （偽 claude）${query} のまとめ — https://example.com/b`;
        return {
          content,
          isError: false,
          toolUseResult: {
            query,
            results: [{ tool_use_id: "srvtoolu_fake", content: [{ title: `${query} の解説`, url: "https://example.com/a" }, { title: `${query} のまとめ`, url: "https://example.com/b" }] }],
            durationSeconds: 0.1,
          },
        };
      }
      case "Skill": {
        const skill = str(input.skill) || str(input.command);
        return { content: `Launching skill: ${skill}`, isError: false, toolUseResult: { success: true, commandName: skill } };
      }
      default:
        return err(`Error: No such tool available: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function abs(t: ToolEnv, file: string): string {
  return path.resolve(t.cwd, file);
}

function read(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const file = abs(t, str(input.file_path));
  if (!existsSync(file)) return err("File does not exist. Note: your current working directory is " + t.cwd + ".");
  if (statSync(file).isDirectory()) return err(`EISDIR: illegal operation on a directory, read '${file}'`);
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
  return {
    content: numbered,
    isError: false,
    toolUseResult: { type: "text", file: { filePath: file, content, numLines: lines.length, startLine: 1, totalLines: lines.length } },
  };
}

function write(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const file = abs(t, str(input.file_path));
  const content = str(input.content);
  const existed = existsSync(file);
  const original = existed ? readFileSync(file, "utf8") : null;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (!existed) {
    return {
      content: `File created successfully at: ${file} (file state is current in your context — no need to Read it back)`,
      isError: false,
      toolUseResult: { type: "create", filePath: file, content, structuredPatch: [], originalFile: null, userModified: false },
    };
  }
  return {
    content: `The file ${file} has been updated successfully.`,
    isError: false,
    toolUseResult: { type: "update", filePath: file, content, structuredPatch: simplePatch(original ?? "", content), originalFile: original, userModified: false },
  };
}

function edit(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const file = abs(t, str(input.file_path));
  if (!existsSync(file)) return err("File does not exist.");
  const original = readFileSync(file, "utf8");
  const oldString = str(input.old_string);
  const newString = str(input.new_string);
  const replaceAll = input.replace_all === true;
  if (oldString === newString) return err("No changes to make: old_string and new_string are exactly the same.");
  const count = oldString === "" ? 0 : original.split(oldString).length - 1;
  if (count === 0) return err(`String to replace not found in file.\nString: ${oldString}`);
  if (count > 1 && !replaceAll) return err(`Found ${count} matches of the string to replace, but replace_all is false.`);
  const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, () => newString);
  writeFileSync(file, updated);
  return {
    content: `The file ${file} has been updated successfully.`,
    isError: false,
    toolUseResult: {
      filePath: file,
      oldString,
      newString,
      originalFile: original,
      structuredPatch: simplePatch(original, updated),
      userModified: false,
      replaceAll,
    },
  };
}

function bash(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const command = str(input.command);
  const timeout = typeof input.timeout === "number" ? Math.min(input.timeout, 600_000) : 120_000;
  const r = spawnSync("/bin/sh", ["-c", command], { cwd: t.cwd, env: t.env, encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  const stdout = (r.stdout ?? "").replace(/\n$/, "");
  const stderr = (r.stderr ?? "").replace(/\n$/, "");
  const tur = { stdout, stderr, interrupted: r.signal !== null, isImage: false, noOutputExpected: false };
  if (r.status !== 0) {
    const body = [stdout, stderr].filter(Boolean).join("\n");
    return { content: `Exit code ${r.status ?? 1}\n${body}`, isError: true, toolUseResult: `Error: Exit code ${r.status ?? 1}\n${body}` };
  }
  const body = [stdout, stderr].filter(Boolean).join("\n");
  return { content: body || "(Bash completed with no output)", isError: false, toolUseResult: tur };
}

function glob(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const pattern = str(input.pattern) || "**/*";
  const base = input.path ? abs(t, str(input.path)) : t.cwd;
  const started = Date.now();
  const re = globRegex(pattern);
  const filenames = walkFiles(base).filter((f) => re.test(f) || (!pattern.includes("/") && re.test(path.basename(f))));
  return {
    content: filenames.length ? filenames.join("\n") : "No files found",
    isError: false,
    toolUseResult: { filenames, durationMs: Date.now() - started, numFiles: filenames.length, truncated: false },
  };
}

function grep(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const pattern = str(input.pattern);
  let re: RegExp;
  try {
    re = new RegExp(pattern, input["-i"] === true ? "i" : "");
  } catch {
    return err(`Invalid regex: ${pattern}`);
  }
  const base = input.path ? abs(t, str(input.path)) : t.cwd;
  const mode = str(input.output_mode) || "files_with_matches";
  const matches: string[] = [];
  const files = new Set<string>();
  const list = existsSync(base) && statSync(base).isFile() ? [path.relative(t.cwd, base)] : walkFiles(base).map((f) => path.relative(t.cwd, path.join(base, f)));
  for (const rel of list) {
    let text: string;
    try {
      text = readFileSync(path.join(t.cwd, rel), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (re.test(line)) {
        files.add(rel);
        matches.push(`${rel}:${i + 1}:${line}`);
      }
    });
  }
  if (mode === "content") {
    const content = matches.join("\n");
    return { content: content || "No matches found", isError: false, toolUseResult: { mode, numFiles: 0, filenames: [], content, numLines: matches.length } };
  }
  const filenames = [...files];
  return {
    content: filenames.length ? `Found ${filenames.length} file${filenames.length === 1 ? "" : "s"}\n${filenames.join("\n")}` : "No files found",
    isError: false,
    toolUseResult: { mode: "files_with_matches", filenames, numFiles: filenames.length },
  };
}

function todoWrite(input: Record<string, unknown>, t: ToolEnv): ToolOutcome {
  const todos = Array.isArray(input.todos) ? (input.todos as Todo[]) : [];
  const old = t.todos;
  t.setTodos(todos);
  return {
    content:
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
    isError: false,
    toolUseResult: { oldTodos: old, newTodos: todos },
  };
}
