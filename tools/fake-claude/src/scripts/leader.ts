// リーダーの台本（DESIGN-v2 4.6・5.5・7.4・14 章・15.2）。最後に StructuredOutput（LeaderTurn）。
import { TURN_TAGS, type CooReport, type LeaderAction, type LeaderTurn, type PlanTask } from "@baton/shared";
import { ceoBody, firstLineOf, isAck, lastOf, linesOf, longText, parseMarkers, rawMarkers, resolveInstruction } from "./common.ts";
import { GENERIC_TEAM, SCENARIO_A_IDEAS, SCENARIO_A_NICHE_IDEAS, numbered } from "./coo.ts";
import type { Script, TurnContext } from "./types.ts";

export const SCENARIO_A_LEADER = {
  plan: "了解です。リサーチと執筆で進めます",
  report: "まとめて COO に報告します",
  niche: "わかりました。リサーチメンバーに参考を集めさせます",
  nicheReport: "CEO と直接話し、題材をニッチ寄りに変更。リサーチに参考集めを指示",
};

/** 次のタスクキー（t1, t2, …。ラウンド 2 でも続きの番号） */
function nextKey(ctx: TurnContext): string {
  const n = Number(ctx.session.flags.nextTask ?? 1);
  ctx.session.flags.nextTask = n + 1;
  return `t${n}`;
}

function task(ctx: TurnContext, t: Omit<PlanTask, "key">): PlanTask {
  const key = nextKey(ctx);
  ctx.session.assignees[key] = t.assignee;
  return { key, ...t };
}

/** 依頼の本文に付いたマーカーをタスクの spec に引き継ぐ（メンバーの台本がそれを見る） */
function carried(ctx: TurnContext, extra: string | null = null): string {
  const keep = rawMarkers(`${extra ?? ""}\n${ctx.input}`).filter((m) => m !== "[ask-coo]" && m !== "[no-report]");
  if (ctx.markers.has("scenario-a") && !keep.includes("[scenario-a]")) keep.unshift("[scenario-a]");
  return keep.length ? ` ${keep.join(" ")}` : "";
}

function planTasks(ctx: TurnContext, brief: string, extra: string | null = null): PlanTask[] {
  const tag = carried(ctx, extra);
  if (ctx.markers.has("scenario-a")) {
    return [
      task(ctx, { title: "題材のリサーチ", spec: `コーヒー紹介の題材を 10 個集め、research/ に書く。完了の条件: research/notes.md がある。${tag}`, assignee: "リサーチ", dependsOn: [], paths: ["research/"] }),
      task(ctx, { title: "台本の執筆", spec: `コーヒー紹介のショート動画の台本を 10 本書き、scripts/ に置く。完了の条件: scripts/scripts.md に 10 本。${tag}`, assignee: "ライター", dependsOn: [], paths: ["scripts/"] }),
    ];
  }
  const [a, b] = GENERIC_TEAM.members;
  const title = firstLineOf(brief, 60) || "テスト";
  if (ctx.markers.has("conflict")) {
    // paths が重なる 2 つのタスク（シナリオ B2）
    return [
      task(ctx, { title: `${title}（A 案）`, spec: `shared/notes.md に A 案を書く。${tag}`, assignee: a!.name, dependsOn: [], paths: ["shared/notes.md"] }),
      task(ctx, { title: `${title}（B 案）`, spec: `shared/notes.md に B 案を書く。${tag}`, assignee: b!.name, dependsOn: [], paths: ["shared/notes.md"] }),
    ];
  }
  if (ctx.markers.has("parallel")) {
    return [
      task(ctx, { title: `${title}（前半）`, spec: `前半を part1/ に書く。${tag}`, assignee: a!.name, dependsOn: [], paths: ["part1/"] }),
      task(ctx, { title: `${title}（後半）`, spec: `後半を part2/ に書く。${tag}`, assignee: b!.name, dependsOn: [], paths: ["part2/"] }),
    ];
  }
  return [task(ctx, { title, spec: `${firstLineOf(brief, 1500)}。完了の条件: 成果を 1 つのファイルにまとめる。${tag}`, assignee: a!.name, dependsOn: [], paths: [] })];
}

/** もとの依頼に [slow] があれば COO への報告にも付ける（COO の最後のターン＝present も遅くする。E41 の版の確認） */
function slowTag(ctx: TurnContext, instructionId: string): string {
  const tag = ctx.session.flags[`tag:${instructionId}`];
  return typeof tag === "string" && tag.includes("[slow]") ? " [slow]" : "";
}

export function* leaderScript(ctx: TurnContext): Script {
  const parts: string[] = [];
  const actions: LeaderAction[] = [];
  let cooReport: CooReport | null = null;
  const scenarioA = ctx.markers.has("scenario-a");

  // COO からの依頼（ask_coo の答え・relay もここに来る）
  for (const brief of linesOf(ctx, TURN_TAGS.coo)) {
    const ref = resolveInstruction(ctx, brief);
    if (ref) {
      ctx.session.flags.instructionId = ref.id;
      ctx.session.flags.revision = ref.revision;
    }
    if (ctx.markers.has("ask-coo") && ctx.session.flags.askedCoo !== true) {
      ctx.session.flags.askedCoo = true;
      // 答え（[COO]）にはもとの依頼のマーカーが無いので覚えておく
      ctx.session.flags.pendingBrief = brief;
      parts.push("進める前に COO に確認します。");
      actions.push({ type: "ask_coo", instructionId: ref?.id ?? null, question: "優先する観点はどれですか？" });
      continue;
    }
    if (!ref) continue;
    const pendingBrief = typeof ctx.session.flags.pendingBrief === "string" ? ctx.session.flags.pendingBrief : null;
    delete ctx.session.flags.pendingBrief;
    if (pendingBrief) for (const m of parseMarkers(pendingBrief, "leader")) ctx.markers.add(m);
    // 同じ指示の 2 回目の依頼（再実行・差し戻しの relay）は、最初の依頼のマーカーを引き継ぐ
    const earlierTag = typeof ctx.session.flags[`tag:${ref.id}`] === "string" ? (ctx.session.flags[`tag:${ref.id}`] as string) : null;
    const tasks = planTasks(ctx, (pendingBrief ?? brief).replace(/（指示 [0-9A-Za-z_-]+）$/, ""), pendingBrief ?? earlierTag);
    // ラウンド 2 のやり直しでも、もとの依頼のマーカーをメンバーに引き継ぐ
    ctx.session.flags[`tag:${ref.id}`] = carried(ctx, pendingBrief ?? earlierTag);
    parts.push(scenarioA ? SCENARIO_A_LEADER.plan : `了解です。${tasks.map((t) => t.assignee).join("と")}で進めます`);
    actions.push({ type: "plan", instructionId: ref.id, newTitle: null, tasks });
  }

  // メンバーの結果 → report
  for (const results of linesOf(ctx, TURN_TAGS.memberResults)) {
    const ref = resolveInstruction(ctx, results);
    if (!ref) continue;
    // 全部失敗したら 1 回だけやり直しを足す（ラウンド 2。5.5「全 work が失敗してもリーダーに渡す（リーダーが追加か report を決める）」）
    const outcomes = [...results.matchAll(/^- \S+ .*?（([a-z_]+)）:/gm)].map((m) => m[1]);
    const retryFlag = `retried:${ref.id}`;
    if (outcomes.length > 0 && outcomes.every((o) => o === "failed" || o === "canceled") && ctx.session.flags[retryFlag] !== true) {
      ctx.session.flags[retryFlag] = true;
      const tag = typeof ctx.session.flags[`tag:${ref.id}`] === "string" ? (ctx.session.flags[`tag:${ref.id}`] as string) : carried(ctx);
      const [a] = GENERIC_TEAM.members;
      parts.push("うまくいかなかったので、もう一度やり直してもらいます");
      actions.push({
        type: "plan",
        instructionId: ref.id,
        newTitle: null,
        tasks: [task(ctx, { title: "やり直し", spec: `前回の作業が失敗したのでやり直す。完了の条件: 成果を 1 つのファイルにまとめる。${tag}`, assignee: a!.name, dependsOn: [], paths: [] })],
      });
      continue;
    }
    const niche = scenarioA && ctx.session.flags.niche === true;
    const summary = scenarioA
      ? niche
        ? `ニッチ寄りに組み直した 10 本の案です。\n${numbered(SCENARIO_A_NICHE_IDEAS)}`
        : `10 本の案です。\n${numbered(SCENARIO_A_IDEAS)}`
      : `メンバーの結果をまとめました。${slowTag(ctx, ref.id)}\n${results.replace(/（指示 [0-9A-Za-z_-]+）$/, "")}`;
    parts.push(scenarioA ? SCENARIO_A_LEADER.report : "メンバーの結果をまとめて COO に報告します");
    actions.push({ type: "report", instructionId: ref.id, summary: summary.slice(0, 8000), openIssues: [] });
  }

  // メンバーの質問 → answer_member
  for (const q of linesOf(ctx, TURN_TAGS.memberQuestion)) {
    const m = /（セッション ([^）]+)）/.exec(q);
    if (!m) continue;
    const message = "A 案（箇条書き）で進めてください。";
    parts.push(`メンバーに「${message}」と答えました。`);
    actions.push({ type: "answer_member", sessionId: m[1]!, message });
  }

  // 衝突 → resolve_conflict
  for (const c of linesOf(ctx, TURN_TAGS.mergeConflict)) {
    const ref = resolveInstruction(ctx, c);
    const taskKey = /^(t\d{1,2})\b/.exec(c)?.[1];
    if (!ref || !taskKey) continue;
    const assignee = ctx.session.assignees[taskKey] ?? GENERIC_TEAM.members[0]!.name;
    parts.push(`${taskKey} が衝突したので、${assignee}に解決を頼みます。`);
    actions.push({ type: "resolve_conflict", instructionId: ref.id, taskKey, assignee });
  }

  // CEO の発言
  const ceoLine = lastOf(ctx, TURN_TAGS.ceo, TURN_TAGS.ceoSendBack);
  if (ceoLine) {
    const text = ceoBody(ceoLine.text);
    const ref = resolveInstruction(ctx, ceoLine.text);
    if (isAck(text)) {
      // 相づち: 書かない・増やさない・報告しない
    } else if (scenarioA && /ニッチ/.test(text) && ref) {
      ctx.session.flags.niche = true;
      parts.push(SCENARIO_A_LEADER.niche);
      actions.push({
        type: "plan",
        instructionId: ref.id,
        newTitle: null,
        tasks: [task(ctx, { title: "ニッチな題材の参考集め", spec: `ニッチな題材の参考を集め、research/ に書く。完了の条件: research/niche.md がある。${carried(ctx)}`, assignee: "リサーチ", dependsOn: [], paths: ["research/"] })],
      });
      cooReport = { summary: SCENARIO_A_LEADER.nicheReport, change: "direction", instructionIds: [ref.id] };
    } else {
      parts.push("わかりました。その方針でメンバーに頼みます。");
      const tasks = planTasks(ctx, text);
      actions.push({ type: "plan", instructionId: ref?.id ?? null, newTitle: ref ? null : firstLineOf(text) || "テスト", tasks });
      // [no-report] は報告を会話の区切りまで持ち越す（R22 用）
      if (!ctx.markers.has("no-report")) {
        cooReport = {
          summary: `CEO から「${firstLineOf(text, 200)}」と依頼があり、${tasks.map((t) => t.assignee).join("と")}に頼んだ`,
          change: ref ? "direction" : "new_work",
          instructionIds: ref ? [ref.id] : [],
        };
      }
    }
    if (!isAck(text) && cooReport === null) ctx.session.flags.lastCeo = text;
  }

  // 会話の区切り → 未報告があれば cooReport
  if (linesOf(ctx, TURN_TAGS.conversationBreak).length > 0 && cooReport === null && typeof ctx.session.flags.lastCeo === "string") {
    const ref = resolveInstruction(ctx, null);
    cooReport = { summary: `CEO と話した内容: ${firstLineOf(ctx.session.flags.lastCeo, 400)}`, change: "none", instructionIds: ref ? [ref.id] : [] };
    delete ctx.session.flags.lastCeo;
  }
  if (cooReport !== null) delete ctx.session.flags.lastCeo;

  if (ctx.markers.has("long") && parts.length > 0) parts.push(longText(200));
  const reply = parts.join("\n\n");
  if (reply) yield { kind: "text", text: reply };
  const value: LeaderTurn = { reply: null, awaitingReply: false, actions, cooReport };
  yield { kind: "output", value };
}
