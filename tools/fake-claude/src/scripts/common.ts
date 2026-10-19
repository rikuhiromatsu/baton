// 台本の共通部品: マーカー、札の読み取り、指示 ID と版の拾い方、相づちの見分け。
import { TURN_TAGS, type TurnLine, type TurnTag } from "@baton/shared";
import type { TurnContext } from "./types.ts";

const MARKER = /\[([a-z][a-z0-9-]*)(?:@(coo|leader|member))?\]/g;

/**
 * 入力の中のマーカー（[scenario-a]・[approve] など。英小文字・数字・ハイフンだけ。日本語の札とは重ならない）。
 * `[fail@member]` のように @役割 を付けると、その役割のときだけ効く（CEO の発言に書いても COO は失敗しない）。
 */
export function parseMarkers(text: string, role: string | null = null): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(MARKER)) if (!m[2] || m[2] === role) out.add(m[1]!);
  return out;
}

/** マーカーを書いたとおりに（@役割 も残す。リーダーがタスクの spec に引き継ぐため） */
export function rawMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER)].map((m) => m[0]))];
}

/** 一度出たらセッションの間ずっと効くマーカー */
export const STICKY_MARKERS = new Set(["scenario-a"]);

/** 表示用にマーカーを外す */
export function stripMarkers(text: string): string {
  return text.replace(/\s*\[[a-z][a-z0-9-]*(?:@(?:coo|leader|member))?\]\s*/g, " ").replace(/[ \t]+/g, " ").trim();
}

export function linesOf(ctx: TurnContext, tag: TurnTag): string[] {
  return ctx.lines.filter((l) => l.tag === tag).map((l) => l.text);
}

export function lastOf(ctx: TurnContext, ...tags: TurnTag[]): TurnLine | null {
  for (let i = ctx.lines.length - 1; i >= 0; i--) if (tags.includes(ctx.lines[i]!.tag)) return ctx.lines[i]!;
  return null;
}

export type InstructionState = { id: string; title: string; status: string; revision: number };

/** [指示の状態] 1a2b…「タイトル」running（リーダー作業中）rev 2 を読む（turn-input.ts の instructionStateLine の逆） */
export function parseInstructionStates(ctx: TurnContext): InstructionState[] {
  const out: InstructionState[] = [];
  for (const text of linesOf(ctx, TURN_TAGS.instructionState)) {
    const m = /^(\S+?)「([\s\S]*?)」([a-z_]+)(?:（[^）]*）)?\s?rev (\d+)/.exec(text);
    if (m) out.push({ id: m[1]!, title: m[2]!, status: m[3]!, revision: Number(m[4]) });
  }
  return out;
}

/** 「（指示 1a2b3c4d）」の短い ID */
export function shortInstructionRef(text: string): string | null {
  const m = /（指示 ([0-9A-Za-z_-]+)）/.exec(text);
  return m ? m[1]! : null;
}

/** 短い ID（無ければ最後の [指示の状態]）から、ID と版を決める */
export function resolveInstruction(ctx: TurnContext, text: string | null): { id: string; revision: number } | null {
  const states = parseInstructionStates(ctx);
  const short = text ? shortInstructionRef(text) : null;
  if (short) {
    const hit = states.find((s) => s.id.startsWith(short));
    if (hit) return { id: hit.id, revision: hit.revision };
    return { id: short, revision: 1 };
  }
  const last = states[states.length - 1];
  if (last) return { id: last.id, revision: last.revision };
  const remembered = ctx.session.flags.instructionId;
  if (typeof remembered === "string") return { id: remembered, revision: Number(ctx.session.flags.revision ?? 1) };
  return null;
}

const ACK = /^(たすかる|助かる|たすかり|ありがと|ありがとう|ありがとうございます|了解|りょうかい|おけ|おっけー|ok|okay|いいね|さすが|おつかれ|お疲れ|👍|🙏)/i;

/** 相づち（返事も行動も要らない。D-77） */
export function isAck(text: string): boolean {
  const t = stripMarkers(text).replace(/[！!。、.,\s〜~]/g, "");
  return t.length > 0 && t.length <= 20 && ACK.test(t);
}

/** CEO の言葉の頭に付く「（プロジェクト について）」を外す */
export function ceoBody(text: string): string {
  return text.replace(/^（[^）]*について）/, "").replace(/（指示 [0-9A-Za-z_-]+）$/, "").trim();
}

export function firstLineOf(text: string, max = 60): string {
  const line = stripMarkers(text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? line.slice(0, max) : line;
}

/** 長い返事（[long]）の本文 */
export function longText(n: number): string {
  const paras: string[] = [];
  for (let i = 1; i <= n; i++) paras.push(`${i}. 長い返事の段落です。仮想化と量の上限を確かめるための文章を、同じ調子で続けています。`);
  return paras.join("\n");
}
