// FakeAi: 台本を順に返す AI（設計書 8.2）。各ルールは match（任意）に合う呼び出しに times 回まで使われる。
import type { AiChatInput, AiChatOutput } from "@baton/shared";
import { toApiError } from "../../src/api.ts";

export type Reply = string | { text: string; tokensIn?: number; tokensOut?: number; model?: string; usedFallback?: boolean } | { error: Error };
export type ReplyFn = (input: AiChatInput, signal: AbortSignal | undefined) => Reply | Promise<Reply>;
export type Rule = { name?: string; match?: (input: AiChatInput) => boolean; reply: Reply | ReplyFn; times?: number; delayMs?: number };

export function stageOf(input: AiChatInput): string {
  const sys = input.messages.find((m) => m.role === "system")?.content ?? "";
  return /^ROLE: (\S+)/.exec(sys)?.[1] ?? "";
}
export function firstUser(input: AiChatInput): string {
  return input.messages.find((m) => m.role === "user")?.content ?? "";
}
export function taskKeyOf(input: AiChatInput): string | null {
  return /^TASK_KEY: (\S+)$/m.exec(firstUser(input))?.[1] ?? null;
}
export function hasToolResult(input: AiChatInput): boolean {
  return input.messages.some((m) => m.role === "user" && m.content.startsWith("TOOL_RESULT "));
}
export function lastUser(input: AiChatInput): string {
  const us = input.messages.filter((m) => m.role === "user");
  return us[us.length - 1]?.content ?? "";
}

export const isStage = (stage: string, extra?: (i: AiChatInput) => boolean) => (i: AiChatInput) => stageOf(i) === stage && (extra ? extra(i) : true);

export class FakeAi {
  readonly rules: (Rule & { used: number })[] = [];
  readonly calls: AiChatInput[] = [];
  inFlight = 0;
  maxInFlight = 0;
  aborted = 0;

  add(...rules: Rule[]): this {
    for (const r of rules) this.rules.push({ ...r, used: 0 });
    return this;
  }

  async respond(input: AiChatInput, signal?: AbortSignal): Promise<AiChatOutput> {
    this.calls.push(input);
    const rule = this.rules.find((r) => r.used < (r.times ?? 1) && (!r.match || r.match(input)));
    if (!rule) throw new Error(`FakeAi: 台本がありません（stage=${stageOf(input)} task=${taskKeyOf(input)} 呼び出し ${this.calls.length} 回目）`);
    rule.used++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (rule.delayMs) await abortableDelay(rule.delayMs, signal);
      const reply = typeof rule.reply === "function" ? await rule.reply(input, signal) : rule.reply;
      if (signal?.aborted) throw signal.reason;
      if (typeof reply === "string") return { text: reply, model: "fake-model", usedFallback: !!input.preferFallback, usage: { tokensIn: 100, tokensOut: 50 } };
      if ("error" in reply) throw reply.error;
      return {
        text: reply.text,
        model: reply.model ?? (input.preferFallback ? "fake-fallback" : "fake-model"),
        usedFallback: reply.usedFallback ?? !!input.preferFallback,
        usage: { tokensIn: reply.tokensIn ?? 100, tokensOut: reply.tokensOut ?? 50 },
      };
    } catch (err) {
      if (signal?.aborted) this.aborted++;
      throw err;
    } finally {
      this.inFlight--;
    }
  }

  callsFor(stage: string): AiChatInput[] {
    return this.calls.filter((c) => stageOf(c) === stage);
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** 中止されるまで返さない */
export const hang: ReplyFn = (_i, signal) =>
  new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** Worker が返す 429 ai_quota（HttpBatonApi と同じ変換を通す） */
export function quotaError(retryAt: number, scope?: string): Error {
  return toApiError(429, { error: { code: "ai_quota", message: "AI の枠切れ", details: { retryAt, ...(scope ? { scope } : {}) } } });
}
export function unavailableError(): Error {
  return toApiError(503, { error: { code: "ai_unavailable", message: "AI が使えません" } });
}

// ───────────── よく使う応答 ─────────────

export const J = (o: unknown) => JSON.stringify(o);

export const routeNew = (over: Record<string, unknown> = {}) =>
  J({
    kind: "route",
    title: "テストの指示",
    project: {
      mode: "new",
      name: "テスト",
      slug: "test",
      summary: "テスト用のプロジェクト",
      leader: { name: "リーダー", specialty: "取りまとめ" },
      members: [
        { name: "調査担当", specialty: "調べもの" },
        { name: "執筆担当", specialty: "文章" },
      ],
    },
    brief: "メモを 2 つ書く",
    ...over,
  });

export const plan2 = (deps: Record<string, string[]> = {}) =>
  J({
    kind: "plan",
    tasks: [
      { key: "t1", title: "調査", spec: "notes/t1.md に書く。完了の条件: ファイルがある", assignee: "調査担当", dependsOn: deps.t1 ?? [] },
      { key: "t2", title: "執筆", spec: "notes/t2.md に書く。完了の条件: ファイルがある", assignee: "執筆担当", dependsOn: deps.t2 ?? [] },
    ],
  });

export const memberWrite = (key: string) => J({ kind: "tool", tool: "fs_write", args: { path: `notes/${key}.md`, content: `# ${key}\n本文 ${key}\n` }, why: "書く" });
export const memberDone = (key: string) => J({ kind: "done", summary: `${key} を書きました`, artifacts: [{ path: `notes/${key}.md`, title: `メモ ${key}` }] });
export const reviewReport = J({ kind: "report", summary: "2 つのメモができました", openIssues: [] });
export const finalReport = J({ kind: "final", report: "テスト報告: すべて完了しました" });
export const askCeo = (q = "どちらにしますか") => J({ kind: "ask_ceo", question: q, options: ["A案", "B案"] });

/** ScriptedAiClient の通常の流れと同じ台本（並列の t1/t2 は TASK_KEY で振り分ける） */
export function normalRules(opts: { memberDelayMs?: number } = {}): Rule[] {
  return [
    { name: "route", match: isStage("coo_route"), reply: routeNew() },
    { name: "plan", match: isStage("leader_plan"), reply: plan2() },
    ...["t1", "t2"].flatMap((k) => [
      { name: `${k}-write`, match: isStage("member_step", (i) => taskKeyOf(i) === k && !hasToolResult(i)), reply: memberWrite(k), delayMs: opts.memberDelayMs },
      { name: `${k}-done`, match: isStage("member_step", (i) => taskKeyOf(i) === k && hasToolResult(i)), reply: memberDone(k) },
    ]),
    { name: "review", match: isStage("leader_review"), reply: reviewReport },
    { name: "final", match: isStage("coo_final"), reply: finalReport },
  ];
}
