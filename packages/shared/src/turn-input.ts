// 受信箱 → ターンの入力文（DESIGN-v2 4.5・4.6・5.6）。
// ランナーは行の頭の札で種類を示して書き、偽 claude は同じ札で台本を選ぶ（15.2）。
// 例:
//   [文脈] 日時: 2026-10-21 10:12 / CEO が見ている画面: プロジェクト「ショート動画台本」
//   [リーダーからの報告] 台本: CEO と直接話し、題材をニッチ寄りに変更。…
//   [指示の状態] 1a2b3c4d「コーヒー紹介の台本 10 本」running（リーダー作業中）rev 2
//   [CEO] たすかる！

/** 札。COO 向けは 4.5 のとおり。リーダー・メンバー向けは D-96 で足したもの */
export const TURN_TAGS = {
  // COO スレッド（4.5）
  ceo: "[CEO]",
  ceoSendBack: "[CEO の差し戻し]",
  secretary: "[秘書]",
  leaderReport: "[リーダーからの報告]",
  leaderWorkReport: "[リーダーの成果報告]",
  leaderQuestion: "[リーダーの質問]",
  notice: "[知らせ]",
  instructionState: "[指示の状態]",
  context: "[文脈]",
  // リーダーのスレッド（D-96）
  coo: "[COO]",
  memberResults: "[メンバーの結果]",
  memberQuestion: "[メンバーの質問]",
  mergeConflict: "[衝突]",
  reviewFindings: "[Codex の指摘]",
  conversationBreak: "[会話の区切り]",
  // メンバーのセッション（D-96）
  task: "[タスク]",
  leader: "[リーダー]",
  ceoFollowUp: "[CEO の追加の依頼]",
  ceoAnswer: "[CEO の回答]",
  runner: "[ランナー]",
} as const;
export type TurnTagKey = keyof typeof TURN_TAGS;
export type TurnTag = (typeof TURN_TAGS)[TurnTagKey];

const TAG_VALUES = Object.values(TURN_TAGS) as readonly string[];

export type TurnLine = { tag: TurnTag; text: string };

/** 行の中の改行は札の付いた行の続き（次の札まで）として扱う。札で始まる続きの行は頭に全角空白を入れて札と誤読させない */
function escapeBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (TAG_VALUES.some((t) => l.startsWith(t)) ? `　${l}` : l))
    .join("\n");
}

/** 札付きの行を 1 つの入力文にする */
export function buildTurnInput(lines: readonly TurnLine[]): string {
  return lines.map((l) => `${l.tag} ${escapeBody(l.text.trim())}`).join("\n");
}

/** 入力文を札ごとに分ける（偽 claude とテスト用）。札の無い頭の行は捨てる */
export function parseTurnInput(text: string): TurnLine[] {
  const out: TurnLine[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const tag = TAG_VALUES.find((t) => raw.startsWith(t)) as TurnTag | undefined;
    if (tag) {
      out.push({ tag, text: raw.slice(tag.length).trimStart() });
    } else if (out.length > 0) {
      const last = out[out.length - 1]!;
      const escaped = raw.startsWith("　") && TAG_VALUES.some((t) => raw.slice(1).startsWith(t));
      last.text += `\n${escaped ? raw.slice(1) : raw}`;
    }
  }
  return out;
}

// ───────────── 受信箱の項目 → 行 ─────────────

export const INBOX_KINDS = [
  "ceo_message",
  "delegation",
  "member_results",
  "member_question",
  "work_report",
  "leader_report",
  "merge_conflict",
  "project_created",
  "secretary_message",
  "review_findings",
  "instruction_event",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * 受信箱の 1 件。payload の形は種類ごと（ランナーが入れたもの、Worker が入れたもの）。
 * - ceo_message: { body, sendBack?: boolean, contextProjectName?: string }
 * - secretary_message: { body }
 * - delegation（COO → リーダー）: { body }。リーダー → COO の ask_coo も delegation で { question }（D-96）
 * - member_results: { results: [{ taskKey, assignee, outcome, summary }], diffStat? }
 * - member_question: { sessionId, assignee, question }
 * - work_report: { leaderName, summary, openIssues }
 * - leader_report: { leaderName, summary, change }
 * - merge_conflict: { taskKey, files: string[] }
 * - project_created / instruction_event: { text }。instruction_event の { type: "conversation_break" } は会話の区切り（4.6）
 * - review_findings: { text }
 */
export type InboxEntry = { kind: InboxKind; instructionId: string | null; payload: Record<string, unknown> };

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const short = (id: string | null) => (id ? id.slice(0, 8) : "");

/** 「（指示 1a2b3c4d）」の添え書き */
function withInstruction(text: string, instructionId: string | null): string {
  return instructionId ? `${text}（指示 ${short(instructionId)}）` : text;
}

export const CONVERSATION_BREAK_TEXT = "まだ COO に伝えていないことがあれば cooReport で";

/** 受信箱の 1 件を札付きの行にする。threadKind で COO 側とリーダー側の札を選ぶ */
export function inboxEntryToLine(entry: InboxEntry, threadKind: "coo" | "leader"): TurnLine {
  const p = entry.payload;
  switch (entry.kind) {
    case "ceo_message": {
      const ctx = typeof p.contextProjectName === "string" && p.contextProjectName ? `（${p.contextProjectName} について）` : "";
      return { tag: p.sendBack ? TURN_TAGS.ceoSendBack : TURN_TAGS.ceo, text: withInstruction(`${ctx}${str(p.body)}`, p.sendBack ? entry.instructionId : null) };
    }
    case "secretary_message":
      return { tag: TURN_TAGS.secretary, text: str(p.body) };
    case "delegation":
      if (threadKind === "coo") return { tag: TURN_TAGS.leaderQuestion, text: withInstruction(str(p.question ?? p.body), entry.instructionId) };
      return { tag: TURN_TAGS.coo, text: withInstruction(str(p.body), entry.instructionId) };
    case "leader_report":
      return { tag: TURN_TAGS.leaderReport, text: withInstruction(`${str(p.leaderName)}: ${str(p.summary)}`, entry.instructionId) };
    case "work_report": {
      const issues = Array.isArray(p.openIssues) && p.openIssues.length ? `\n残課題: ${p.openIssues.map(str).join(" / ")}` : "";
      return { tag: TURN_TAGS.leaderWorkReport, text: withInstruction(`${str(p.leaderName)}: ${str(p.summary)}${issues}`, entry.instructionId) };
    }
    case "member_results": {
      const results = Array.isArray(p.results) ? (p.results as Record<string, unknown>[]) : [];
      const body = results.map((r) => `- ${str(r.taskKey)} ${str(r.assignee)}（${str(r.outcome)}）: ${str(r.summary)}`).join("\n");
      const diff = p.diffStat ? `\n変更: ${str(p.diffStat)}` : "";
      return { tag: TURN_TAGS.memberResults, text: withInstruction(`${body}${diff}`, entry.instructionId) };
    }
    case "member_question":
      return { tag: TURN_TAGS.memberQuestion, text: `${str(p.assignee)}（セッション ${str(p.sessionId)}）: ${str(p.question)}` };
    case "merge_conflict":
      return {
        tag: TURN_TAGS.mergeConflict,
        text: withInstruction(`${str(p.taskKey)}: ${(Array.isArray(p.files) ? p.files.map(str) : []).join(", ")}`, entry.instructionId),
      };
    case "review_findings":
      return { tag: TURN_TAGS.reviewFindings, text: withInstruction(str(p.text), entry.instructionId) };
    case "project_created":
      return { tag: TURN_TAGS.notice, text: str(p.text) };
    case "instruction_event":
      if (p.type === "conversation_break") return { tag: TURN_TAGS.conversationBreak, text: CONVERSATION_BREAK_TEXT };
      return { tag: TURN_TAGS.notice, text: withInstruction(str(p.text), entry.instructionId) };
  }
}

// ───────────── 文脈と指示の状態 ─────────────

/** [文脈] の行（日時は Asia/Tokyo の「YYYY-MM-DD HH:mm」） */
export function contextLine(input: { now: number; viewing?: string | null }): TurnLine {
  const d = new Date(input.now + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { tag: TURN_TAGS.context, text: input.viewing ? `日時: ${at} / CEO が見ている画面: ${input.viewing}` : `日時: ${at}` };
}

const PHASE_TEXT = { leader: "リーダー作業中", members: "メンバー作業中", coo: "COO の番" } as const;

/** [指示の状態] の行。COO の relay・present はここに書いた版を持つ（4.6・D-79） */
export function instructionStateLine(i: {
  id: string;
  title: string;
  status: string;
  phase: "leader" | "members" | "coo" | null;
  revision: number;
  talkingWithCeo?: boolean;
}): TurnLine {
  const phase = i.phase ? `（${PHASE_TEXT[i.phase]}${i.talkingWithCeo ? "・CEO とリーダーが話し中" : ""}）` : i.talkingWithCeo ? "（CEO とリーダーが話し中）" : "";
  return { tag: TURN_TAGS.instructionState, text: `${i.id}「${i.title}」${i.status}${phase}${phase ? "" : " "}rev ${i.revision}` };
}

/**
 * 1 ターンの入力を組み立てる。並びは [文脈] → 報告・知らせ（wakes=0 のものも）→ [指示の状態] → CEO・秘書の発言。
 * CEO の言葉が最後に来るようにして、返事の相手を明確にする。
 */
export function buildThreadTurnInput(input: {
  threadKind: "coo" | "leader";
  now: number;
  viewing?: string | null;
  inbox: readonly InboxEntry[];
  instructions: readonly Parameters<typeof instructionStateLine>[0][];
}): string {
  const head: TurnLine[] = [contextLine({ now: input.now, viewing: input.viewing })];
  const middle: TurnLine[] = [];
  const tail: TurnLine[] = [];
  for (const e of input.inbox) {
    const line = inboxEntryToLine(e, input.threadKind);
    if (e.kind === "ceo_message" || e.kind === "secretary_message") tail.push(line);
    else middle.push(line);
  }
  const states = input.instructions.map(instructionStateLine);
  return buildTurnInput([...head, ...middle, ...states, ...tail]);
}

/** メンバーの最初の入力（5.6） */
export function buildMemberTaskInput(input: {
  title: string;
  spec: string;
  paths: readonly string[];
  goal: string;
  dependencyResults: readonly { taskKey: string; summary: string }[];
  worktree: string;
}): string {
  const lines: TurnLine[] = [
    { tag: TURN_TAGS.task, text: `${input.title}\n${input.spec}` },
    { tag: TURN_TAGS.context, text: `プロジェクトの目的: ${input.goal || "（未設定）"}\n作業フォルダ: ${input.worktree}\n触ってよい範囲: ${input.paths.length ? input.paths.join(", ") : "（指定なし）"}` },
  ];
  for (const d of input.dependencyResults) lines.push({ tag: TURN_TAGS.memberResults, text: `${d.taskKey}: ${d.summary}` });
  return buildTurnInput(lines);
}

/** 行の中に札があるか（偽 claude の台本選び） */
export function hasTag(text: string, tag: TurnTag): boolean {
  return parseTurnInput(text).some((l) => l.tag === tag);
}

/** ある札の行の本文を全部（偽 claude の台本選び） */
export function linesWithTag(text: string, tag: TurnTag): string[] {
  return parseTurnInput(text)
    .filter((l) => l.tag === tag)
    .map((l) => l.text);
}
