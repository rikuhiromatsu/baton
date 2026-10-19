// メンバーの台本（DESIGN-v2 5.6・7.4・7.6・15.2）。道具は cwd（自分の worktree）の中で本当に動く。
// 最後に StructuredOutput（--json-schema が MemberOutputWire なら送る形、判別共用体ならそのまま）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { TURN_TAGS } from "@baton/shared";
import { shortHash, type MemberTask } from "../store.ts";
import { walkFiles } from "../tools.ts";
import { firstLineOf, lastOf, linesOf, parseMarkers, stripMarkers } from "./common.ts";
import { SCENARIO_A_IDEAS, SCENARIO_A_NICHE_IDEAS, numbered } from "./coo.ts";
import type { Script, Step, StepResult, TurnContext } from "./types.ts";

type Output =
  | { kind: "done"; summary: string; artifacts: { path: string; title: string }[] }
  | { kind: "give_up"; reason: string }
  | { kind: "ask_leader"; question: string };

/** --json-schema が送る形（最上位 object・nullable の項目）なら全部の項目を埋める。D-97 */
export function memberValue(schema: Record<string, unknown> | null, out: Output): unknown {
  const props = (schema?.properties ?? null) as Record<string, unknown> | null;
  if (props && "kind" in props && ("reason" in props || "question" in props || "artifacts" in props)) {
    return {
      kind: out.kind,
      summary: out.kind === "done" ? out.summary : null,
      artifacts: out.kind === "done" ? out.artifacts : null,
      reason: out.kind === "give_up" ? out.reason : null,
      question: out.kind === "ask_leader" ? out.question : null,
    };
  }
  return out;
}

export const MEMBER_QUESTION = "形式は箇条書きと表のどちらにしますか？";
export const APPROVAL_COMMAND = "echo ok > approved.txt";

/** [文脈] の「触ってよい範囲: a, b」 */
function pathsFrom(ctx: TurnContext): string[] {
  for (const c of linesOf(ctx, TURN_TAGS.context)) {
    const m = /触ってよい範囲: (.*)/.exec(c);
    if (m) return m[1]!.trim() === "（指定なし）" ? [] : m[1]!.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function slugTitle(t: MemberTask): string {
  return `result-${shortHash(`${t.title}\n${t.spec}`)}`;
}

/** 書くファイル（cwd からの相対） */
export function outputFile(t: MemberTask, scenarioA: boolean): string {
  const p = t.paths[0];
  if (scenarioA) {
    if (/ニッチ/.test(t.title + t.spec)) return "research/niche.md";
    if ((p ?? "").startsWith("research") || /リサーチ/.test(t.title)) return "research/notes.md";
    return "scripts/scripts.md";
  }
  if (!p) return `output/${slugTitle(t)}.md`;
  if (/\.[A-Za-z0-9]+$/.test(p) && !p.endsWith("/")) return p.replace(/^\/+/, "");
  return path.join(p.replace(/^\/+/, ""), `${slugTitle(t)}.md`);
}

function fileContent(t: MemberTask, scenarioA: boolean, file: string): string {
  if (scenarioA) {
    if (file === "research/niche.md") return `# ニッチな題材の参考\n\n${numbered(SCENARIO_A_NICHE_IDEAS)}\n`;
    if (file === "research/notes.md") return `# 題材のリサーチ\n\n${numbered(SCENARIO_A_IDEAS)}\n`;
    return `# コーヒー紹介の台本 10 本\n\n${SCENARIO_A_IDEAS.map((idea, i) => `## ${i + 1}. ${idea}\n\nつかみ → 中身 → まとめ（30 秒）。\n`).join("\n")}`;
  }
  const answer = t.answer ? `\n\n回答: ${t.answer}` : "";
  return `# ${stripMarkers(t.title)}\n\n${stripMarkers(t.spec)}${answer}\n`;
}

/** 衝突の印のあるファイル（衝突の解決タスク。7.4） */
function conflictedFiles(cwd: string): string[] {
  const out: string[] = [];
  for (const rel of walkFiles(cwd, 500)) {
    try {
      const text = readFileSync(path.join(cwd, rel), "utf8");
      if (/^<{7} /m.test(text) && /^>{7} /m.test(text)) out.push(rel);
    } catch {
      // 読めないものは飛ばす
    }
  }
  return out;
}

/** 衝突の印を外し、両方の側を残す */
export function resolveConflictText(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^(<{7}|={7}|>{7}|\|{7})( |$)/.test(l))
    .join("\n");
}

function* todo(ctx: TurnContext, items: string[], done: number): Generator<Step, void, StepResult> {
  yield {
    kind: "tool",
    name: "TodoWrite",
    input: {
      todos: items.map((content, i) => ({
        content,
        status: i < done ? "completed" : i === done ? "in_progress" : "pending",
        activeForm: `${content}をしている`,
      })),
    },
  };
}

function* finish(ctx: TurnContext, out: Output): Script {
  yield { kind: "output", value: memberValue(ctx.schema, out) };
}

export function* memberScript(ctx: TurnContext): Script {
  const s = ctx.session;
  const taskLine = lastOf(ctx, TURN_TAGS.task);
  if (taskLine) {
    const [title, ...rest] = taskLine.text.split("\n");
    s.member = { title: title ?? "", spec: rest.join("\n"), paths: pathsFrom(ctx), completed: false, asked: false, answer: null, summary: null, artifacts: [] };
  }
  const answer = lastOf(ctx, TURN_TAGS.leader, TURN_TAGS.ceoAnswer);
  if (answer && s.member) s.member.answer = answer.text;
  const followUp = lastOf(ctx, TURN_TAGS.ceoFollowUp);
  const t = s.member;
  if (!t) {
    // [タスク] を受けていない（再開の入力だけ）: 何をすればよいか分からないので諦める
    yield* finish(ctx, { kind: "give_up", reason: "タスクの内容を受け取っていません" });
    return;
  }
  const markers = new Set([...ctx.markers, ...parseMarkers(`${t.title}\n${t.spec}`, "member")]);
  const scenarioA = markers.has("scenario-a");

  // 終わったあとの追加の依頼（5.6）
  if (t.completed && followUp) {
    const file = t.artifacts[0]?.path ?? outputFile(t, scenarioA);
    const read = yield { kind: "tool", name: "Read", input: { file_path: path.join(ctx.cwd, file) } };
    const before = read?.ok ? (read.toolUseResult as { file?: { content?: string } }).file?.content ?? "" : "";
    const w = yield { kind: "tool", name: "Write", input: { file_path: path.join(ctx.cwd, file), content: `${before.replace(/\n*$/, "\n")}\n## 追加の依頼\n\n${followUp.text}\n` } };
    if (!w?.ok) {
      yield* finish(ctx, { kind: "give_up", reason: `追加の依頼の書き込みに失敗しました: ${firstLineOf(w?.content ?? "", 300)}` });
      return;
    }
    t.summary = `追加の依頼に対応しました: ${firstLineOf(followUp.text, 200)}`;
    yield* finish(ctx, { kind: "done", summary: t.summary, artifacts: t.artifacts.length ? t.artifacts : [{ path: file, title: "成果" }] });
    return;
  }
  if (t.completed) {
    yield* finish(ctx, { kind: "done", summary: t.summary ?? "完了しています", artifacts: t.artifacts });
    return;
  }

  if (markers.has("giveup")) {
    yield* finish(ctx, { kind: "give_up", reason: "（偽 claude）[giveup] のため諦めます" });
    return;
  }

  // 衝突の解決（印のあるファイルがあれば）
  const conflicted = conflictedFiles(ctx.cwd);
  if (conflicted.length > 0) {
    yield* todo(ctx, ["衝突を確かめる", "衝突を解決する"], 0);
    for (const rel of conflicted) {
      const r = yield { kind: "tool", name: "Read", input: { file_path: path.join(ctx.cwd, rel) } };
      const text = r?.ok ? ((r.toolUseResult as { file?: { content?: string } }).file?.content ?? "") : readFileSync(path.join(ctx.cwd, rel), "utf8");
      const w = yield { kind: "tool", name: "Write", input: { file_path: path.join(ctx.cwd, rel), content: resolveConflictText(text) } };
      if (!w?.ok) {
        // 完了にしない（再開でやり直せるように）
        yield* finish(ctx, { kind: "give_up", reason: `衝突の解決を書けませんでした（${rel}）: ${firstLineOf(w?.content ?? "", 300)}` });
        return;
      }
    }
    yield* todo(ctx, ["衝突を確かめる", "衝突を解決する"], 2);
    t.completed = true;
    t.summary = `衝突を解決しました（両方の内容を残しました）: ${conflicted.join(", ")}`;
    t.artifacts = conflicted.map((p) => ({ path: p, title: "衝突の解決" }));
    yield* finish(ctx, { kind: "done", summary: t.summary, artifacts: t.artifacts });
    return;
  }

  const steps = ["作業フォルダを確かめる", stripMarkers(t.title) || "作業する", "結果を確かめる"];
  yield* todo(ctx, steps, 0);
  yield { kind: "tool", name: "Glob", input: { pattern: "**/*.md" } };

  // 質問（[ask]）: 1 回だけ ask_leader
  if (markers.has("ask") && !t.asked) {
    t.asked = true;
    yield* finish(ctx, { kind: "ask_leader", question: MEMBER_QUESTION });
    return;
  }

  const notes: string[] = [];
  // 承認が要る Bash（[approve]。許可リストの外なのでランナーが CEO に聞く。7.6）
  if (markers.has("approve")) {
    const r = yield { kind: "tool", name: "Bash", input: { command: APPROVAL_COMMAND, description: "承認の確認用のファイルを書く" } };
    notes.push(r?.ok ? "approved.txt を書きました" : "承認されなかったので approved.txt は書きませんでした");
  }
  // 自分の worktree の外への書き込み（[deny]。ランナーの方針で拒否される）
  if (markers.has("deny")) {
    const r = yield { kind: "tool", name: "Write", input: { file_path: path.resolve(ctx.cwd, "..", `outside-${shortHash(ctx.session.sessionId)}.txt`), content: "外に書こうとした\n" } };
    notes.push(r?.ok ? "作業フォルダの外に書きました（拒否されるはずでした）" : "作業フォルダの外への書き込みは拒否されました");
  }

  yield* todo(ctx, steps, 1);
  const file = outputFile(t, scenarioA);
  const w = yield { kind: "tool", name: "Write", input: { file_path: path.join(ctx.cwd, file), content: fileContent(t, scenarioA, file) } };
  if (!w?.ok) {
    // 成果を書けなかった: done にせず、完了の印も付けない（再開でやり直す）
    yield* finish(ctx, { kind: "give_up", reason: `成果を書けませんでした（${file}）: ${firstLineOf(w?.content ?? "", 300)}` });
    return;
  }
  yield* todo(ctx, steps, 3);

  t.completed = true;
  t.artifacts = [{ path: file, title: stripMarkers(t.title).slice(0, 80) || "成果" }];
  t.summary = [`${stripMarkers(t.title) || "タスク"}を終えました。${file} に書きました。`, ...notes].join("\n");
  yield* finish(ctx, { kind: "done", summary: t.summary, artifacts: t.artifacts });
}
