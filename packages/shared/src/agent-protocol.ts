// LLM が 1 ターンに返す JSON アクション（設計書 5.3）。ランナーが zod で検査し、Worker に JSON Schema を渡す。
import { z } from "zod";

export const AskCeo = z.object({
  kind: z.literal("ask_ceo"),
  question: z.string().min(1).max(1000),
  options: z.array(z.string().max(200)).max(4),
});
export type AskCeo = z.infer<typeof AskCeo>;

const AgentSeed = z.object({ name: z.string().min(1).max(30), specialty: z.string().max(200) });

export const CooRouteAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("route"),
    title: z.string().min(1).max(60),
    project: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("existing"), projectId: z.string() }),
      z.object({
        mode: z.literal("new"),
        name: z.string().min(1).max(40),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
        summary: z.string().max(400),
        leader: AgentSeed,
        members: z.array(AgentSeed).min(1).max(3),
      }),
    ]),
    brief: z.string().min(1).max(3000),
  }),
  z.object({ kind: z.literal("answer_directly"), title: z.string().min(1).max(60), report: z.string().min(1).max(8000) }),
  AskCeo,
]);
export type CooRouteAction = z.infer<typeof CooRouteAction>;

export const PlanTask = z.object({
  key: z.string().regex(/^t\d{1,2}$/),
  title: z.string().min(1).max(80),
  spec: z.string().min(1).max(2000),
  assignee: z.string().min(1),
  dependsOn: z.array(z.string()).max(5),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const LeaderPlanAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), tasks: z.array(PlanTask).min(1).max(6) }),
  AskCeo,
]);
export type LeaderPlanAction = z.infer<typeof LeaderPlanAction>;

export const MEMBER_TOOLS = ["fs_list", "fs_read", "fs_write", "fs_append", "web_fetch"] as const;
export type MemberTool = (typeof MEMBER_TOOLS)[number];

export const MemberStepAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    tool: z.enum(MEMBER_TOOLS),
    args: z.record(z.string(), z.unknown()),
    why: z.string().max(200),
  }),
  z.object({
    kind: z.literal("done"),
    summary: z.string().min(1).max(3000),
    artifacts: z.array(z.object({ path: z.string().min(1), title: z.string().min(1).max(80) })).max(10),
  }),
  z.object({ kind: z.literal("give_up"), reason: z.string().min(1).max(1000) }),
  AskCeo,
]);
export type MemberStepAction = z.infer<typeof MemberStepAction>;

export const LeaderReviewAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("report"),
    summary: z.string().min(1).max(4000),
    openIssues: z.array(z.string().max(300)).max(5),
  }),
  z.object({
    kind: z.literal("revise"),
    reason: z.string().min(1).max(1000),
    tasks: z.array(PlanTask).min(1).max(6),
  }),
  AskCeo,
]);
export type LeaderReviewAction = z.infer<typeof LeaderReviewAction>;

export const CooFinalAction = z.object({ kind: z.literal("final"), report: z.string().min(1).max(8000) });
export type CooFinalAction = z.infer<typeof CooFinalAction>;

/** 段階ごとのスキーマ。名前は AiChatInput.jsonSchema.name にそのまま使う */
export const STAGE_SCHEMAS = {
  coo_route: CooRouteAction,
  leader_plan: LeaderPlanAction,
  member_step: MemberStepAction,
  leader_review: LeaderReviewAction,
  coo_final: CooFinalAction,
} as const;
export type Stage = keyof typeof STAGE_SCHEMAS;

/** response_format に渡す JSON Schema を作る */
export function stageJsonSchema(stage: Stage): { name: string; schema: Record<string, unknown> } {
  const schema = z.toJSONSchema(STAGE_SCHEMAS[stage], { target: "draft-7" }) as Record<string, unknown>;
  return { name: stage, schema };
}

/**
 * モデルの本文から最初の JSON オブジェクトを取り出す。
 * 前後の文章・```json の囲み・推論の残りがあっても、括弧の対応で最初の {...} を切り出す。
 */
export function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("JSON オブジェクトが見つかりません");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSON オブジェクトが閉じていません");
}

/** 本文を段階のスキーマで検査する。失敗したら zod のエラーを投げる */
export function parseStageAction<S extends Stage>(stage: S, text: string): z.infer<(typeof STAGE_SCHEMAS)[S]> {
  const obj = extractFirstJsonObject(text);
  return STAGE_SCHEMAS[stage].parse(obj) as z.infer<(typeof STAGE_SCHEMAS)[S]>;
}
