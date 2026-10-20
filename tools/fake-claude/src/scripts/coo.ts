// COO の台本（DESIGN-v2 4.5・14 章・15.2）。返事は文章で書き、最後に StructuredOutput（CooTurn）。
import { TURN_TAGS, type CooAction, type CooTurn } from "@baton/shared";
import { shortHash } from "../store.ts";
import { ceoBody, firstLineOf, isAck, lastOf, linesOf, longText, resolveInstruction, stripMarkers } from "./common.ts";
import type { Script, TurnContext } from "./types.ts";

export const SCENARIO_A = {
  question: "なんの動画ですか？",
  delegate: "わかりました、ではチームリーダーに依頼します。",
  firstPresent: "チームリーダーから 10 本の案が上がって来ました。",
  nichePresent: "ニッチ寄りに組み直した 10 本です。",
  projectName: "ショート動画台本",
  projectSlug: "shorts",
};

export const SCENARIO_A_IDEAS = [
  "産地別の味の違いを 30 秒で",
  "浅煎りと深煎りの飲み比べ",
  "ハンドドリップの湯温で変わる味",
  "コンビニコーヒーをおいしくする小技",
  "豆の挽き目と抽出時間",
  "コーヒーと和菓子の組み合わせ",
  "水出しコーヒーの作り方",
  "カフェインの多い・少ない飲み方",
  "家でできるラテアート入門",
  "朝・昼・夜のおすすめの 1 杯",
];

export const SCENARIO_A_NICHE_IDEAS = [
  "標高 2,000m の農園だけで飲み比べ",
  "ナチュラル精製とウォッシュトの香りの差",
  "ゲイシャ種が高い理由を 30 秒で",
  "発酵プロセス（アナエロビック）とは",
  "エチオピアの在来種の多さ",
  "カスカラ（コーヒーの果肉）のお茶",
  "焙煎後の日数で変わる味",
  "硬水と軟水で淹れ比べ",
  "生豆の保存と熟成",
  "コーヒーの花の香りを知っていますか",
];

export const numbered = (items: readonly string[]) => items.map((t, i) => `${i + 1}. ${t}`).join("\n");

/** 汎用のチーム（Baton 専用「テスト」）。リーダーの台本はこの名前で割り振る */
export const GENERIC_TEAM = {
  leader: { name: "リーダー", specialty: "仕事を分けてまとめる" },
  members: [
    { name: "エンジニア", specialty: "作る・直す", profile: "engineer" as const },
    { name: "ライター", specialty: "書く・まとめる", profile: "writer" as const },
  ],
};

const SCENARIO_A_TEAM = {
  leader: { name: "リーダー", specialty: "台本の企画と取りまとめ" },
  members: [
    { name: "リサーチ", specialty: "題材と参考を集める", profile: "researcher" as const },
    { name: "ライター", specialty: "台本を書く", profile: "writer" as const },
  ],
};

/** プロジェクトが立った知らせから ID を拾う（「id: xxx」か UUID） */
export function projectIdFrom(text: string): string | null {
  const m = /(?:id|ID|プロジェクト ID)[:：]\s*([0-9A-Za-z_-]{4,})/.exec(text) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(text);
  return m ? m[1]! : null;
}

function repoPathFor(ctx: TurnContext): string {
  if (ctx.env.FAKE_CLAUDE_REPO_PATH) return ctx.env.FAKE_CLAUDE_REPO_PATH;
  const m = /(\/[^\s"'（）]*sample-repo)\b/.exec(ctx.input);
  if (m) return m[1]!;
  return `${ctx.env.HOME ?? "/tmp"}/projects/sample-repo`;
}

export function* cooScript(ctx: TurnContext): Script {
  const parts: string[] = [];
  const actions: CooAction[] = [];
  let awaitingReply = false;
  const scenarioA = ctx.markers.has("scenario-a");

  // 本物の Opus の揺れ: 返事を本文に書かず、awaitingReply だけを返す（1 回だけ）
  if (ctx.markers.has("silent-ask") && ctx.session.flags.silentAsked !== true) {
    ctx.session.flags.silentAsked = true;
    yield { kind: "output", value: { reply: null, awaitingReply: true, actions: [] } satisfies CooTurn };
    return;
  }

  // リーダーの成果報告 → present（入力の版で）
  const workReports = linesOf(ctx, TURN_TAGS.leaderWorkReport);
  const leaderReports = linesOf(ctx, TURN_TAGS.leaderReport);
  for (const report of workReports) {
    const ref = resolveInstruction(ctx, report);
    // ニッチに組み直したかは指示ごとに覚える（COO のセッションは全テストで 1 本。前の指示の状態を持ち込まない）
    const niche = scenarioA && (leaderReports.length > 0 || /ニッチ/.test(report) || (ref !== null && ctx.session.flags[`niche:${ref.id}`] === true));
    let text: string;
    if (scenarioA) text = niche ? `${SCENARIO_A.nichePresent}\n${numbered(SCENARIO_A_NICHE_IDEAS)}` : `${SCENARIO_A.firstPresent}\n${numbered(SCENARIO_A_IDEAS)}`;
    else text = `チームリーダーから報告が上がりました。\n${stripMarkers(report.replace(/（指示 [0-9A-Za-z_-]+）/, ""))}`;
    parts.push(text);
    if (ref) actions.push({ type: "present", instructionId: ref.id, revision: ref.revision, summary: text });
  }
  if (scenarioA) {
    for (const r of leaderReports) {
      const ref = resolveInstruction(ctx, r);
      if (ref) ctx.session.flags[`niche:${ref.id}`] = true;
    }
  }

  // リーダーの質問 → answer_leader
  for (const q of linesOf(ctx, TURN_TAGS.leaderQuestion)) {
    const ref = resolveInstruction(ctx, q);
    const message = "おまかせします。その方針で進めてください。";
    parts.push(`リーダーから質問があったので「${message}」と答えました。`);
    actions.push({ type: "answer_leader", instructionId: ref?.id ?? null, message });
  }

  // プロジェクトが立った知らせ → 覚えていた依頼を delegate（existing）
  const pending = ctx.session.flags.pendingBrief;
  if (typeof pending === "string") {
    for (const n of linesOf(ctx, TURN_TAGS.notice)) {
      const projectId = projectIdFrom(n);
      if (!projectId) continue;
      parts.push("プロジェクトが立ったので、チームリーダーに依頼します。");
      actions.push({ type: "delegate", title: firstLineOf(pending) || "テスト", project: { mode: "existing", projectId }, brief: pending });
      delete ctx.session.flags.pendingBrief;
      break;
    }
  }

  // CEO の差し戻し → relay
  for (const sb of linesOf(ctx, TURN_TAGS.ceoSendBack)) {
    const ref = resolveInstruction(ctx, sb);
    const message = ceoBody(sb);
    if (ref && message) {
      parts.push("差し戻しの内容をチームリーダーに伝えます。");
      actions.push({ type: "relay", instructionId: ref.id, revision: ref.revision, message });
    }
  }

  // CEO の再実行（右フリック。4.4）→ relay でリーダーにもう一度頼む
  for (const n of linesOf(ctx, TURN_TAGS.notice)) {
    if (!/再実行を求めた/.test(n)) continue;
    const ref = resolveInstruction(ctx, n);
    if (!ref) continue;
    parts.push("CEO から再実行の依頼があったので、チームリーダーにもう一度頼みます。");
    actions.push({ type: "relay", instructionId: ref.id, revision: ref.revision, message: "CEO から再実行の依頼です。もう一度進めてください。" });
  }

  // CEO の発言
  const ceoLine = lastOf(ctx, TURN_TAGS.ceo);
  const secretary = lastOf(ctx, TURN_TAGS.secretary);
  if (ceoLine) {
    const text = ceoBody(ceoLine.text);
    if (isAck(text)) {
      // 相づち: 何も書かない
    } else if (scenarioA && /台本/.test(text) && !/コーヒー/.test(text)) {
      parts.push(SCENARIO_A.question);
      awaitingReply = true;
    } else if (scenarioA && /コーヒー/.test(text)) {
      parts.push(SCENARIO_A.delegate);
      actions.push({
        type: "delegate",
        title: "コーヒー紹介の台本 10 本",
        project: {
          mode: "new",
          name: SCENARIO_A.projectName,
          slug: SCENARIO_A.projectSlug,
          goal: "コーヒー紹介のショート動画の台本を作る [scenario-a]",
          summary: "コーヒー紹介のショート動画の台本を 10 本作る",
          ...SCENARIO_A_TEAM,
        },
        brief: "[scenario-a] コーヒー紹介のショート動画の台本を 10 本。題材は提案してほしいとのこと。リサーチと執筆で進めてください。",
      });
    } else if (ctx.markers.has("propose")) {
      const repo = ctx.markers.has("repo");
      parts.push(repo ? "既存のリポジトリで進めるプロジェクト案を作りました。作業場所を確かめて立ててください。" : "プロジェクト案を作りました。確かめて立ててください。");
      actions.push({
        type: "propose_project",
        name: "テスト",
        slug: `test-${shortHash(`${ctx.session.sessionId}:${ctx.session.turns.length}:${text}`)}`,
        goal: `${firstLineOf(text, 300) || "テスト"}`,
        summary: "偽 claude のプロジェクト案",
        workspace: repo ? { kind: "repo", repoPath: repoPathFor(ctx) } : { kind: "baton" },
        ...GENERIC_TEAM,
      });
      ctx.session.flags.pendingBrief = text;
    } else {
      parts.push("わかりました。チームリーダーに依頼します。");
      actions.push({
        type: "delegate",
        title: firstLineOf(text) || "テスト",
        project: {
          mode: "new",
          name: "テスト",
          slug: `test-${shortHash(`${ctx.session.sessionId}:${ctx.session.turns.length}:${text}`)}`,
          goal: firstLineOf(text, 300) || "テスト",
          summary: "偽 claude のテスト用プロジェクト",
          ...GENERIC_TEAM,
        },
        brief: text,
      });
    }
  } else if (linesOf(ctx, TURN_TAGS.runner).some((l) => /返事の本文が空/.test(l))) {
    parts.push("ご依頼の中身をもう少し教えてください。");
    awaitingReply = true;
  } else if (secretary && parts.length === 0) {
    // 秘書からの依頼では立てない・振らない（11.5）
    parts.push(`秘書から「${firstLineOf(secretary.text)}」と届きました。進めてよいか CEO に確かめます。`);
  }

  if (ctx.markers.has("long") && parts.length > 0) parts.push(longText(200));

  const reply = parts.join("\n\n");
  if (reply) yield { kind: "text", text: reply };
  const value: CooTurn = { reply: null, awaitingReply, actions };
  yield { kind: "output", value };
}
