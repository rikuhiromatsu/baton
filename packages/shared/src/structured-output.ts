// 役割ごとのターンの構造化出力（DESIGN-v2 4.5・4.6・5.6、D-42・D-76）。
// ランナーは z.toJSONSchema で --json-schema に渡し、受け取った result.structured_output をここで検査する。
// 違反は「ターンの失敗」（5.8）。偽 claude もここの型どおりに出す。
import { z } from "zod";

/** COO がチームを組むときに選ぶ職種（runner/profiles/profiles.json のキー。6.2） */
export const MEMBER_PROFILES = ["engineer", "researcher", "writer", "generalist"] as const;
export type MemberProfile = (typeof MEMBER_PROFILES)[number];

/** プロファイルの全キー（COO・リーダーを含む） */
export const PROFILE_IDS = ["coo", "leader", ...MEMBER_PROFILES] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** 職種の表示名（13.6・13.14） */
export const MEMBER_PROFILE_LABELS: Record<MemberProfile, string> = {
  engineer: "エンジニア",
  researcher: "リサーチ",
  writer: "ライター",
  generalist: "なんでも",
};

export const AGENT_ROLES = ["coo", "leader", "member"] as const;
export type TurnRole = (typeof AGENT_ROLES)[number];

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);
const Member = z.object({ name: z.string().max(30), specialty: z.string().max(200), profile: z.enum(MEMBER_PROFILES) });
const LeaderSeed = z.object({ name: z.string().max(30), specialty: z.string().max(200) });

export const ProjectRef = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), projectId: z.string() }),
  // Baton 専用だけ（既存リポジトリは propose_project を通す。D-51）
  z.object({
    mode: z.literal("new"),
    name: z.string().max(40),
    slug: Slug,
    goal: z.string().min(1).max(400),
    summary: z.string().max(400),
    leader: LeaderSeed,
    members: z.array(Member).min(1).max(3),
  }),
]);
export type ProjectRef = z.infer<typeof ProjectRef>;

export const ProposalWorkspace = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baton") }),
  z.object({ kind: z.literal("repo"), repoPath: z.string() }),
]);
export type ProposalWorkspace = z.infer<typeof ProposalWorkspace>;

export const CooAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("propose_project"),
    name: z.string().max(40),
    slug: Slug,
    goal: z.string().min(1).max(400),
    summary: z.string().max(400),
    workspace: ProposalWorkspace,
    leader: LeaderSeed,
    members: z.array(Member).min(1).max(3),
  }),
  z.object({ type: z.literal("delegate"), title: z.string().min(1).max(60), project: ProjectRef, brief: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("relay"), instructionId: z.string(), revision: z.int(), message: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("answer_leader"), instructionId: z.string().nullable(), message: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("present"), instructionId: z.string(), revision: z.int(), summary: z.string().min(1).max(12000) }),
]);
export type CooAction = z.infer<typeof CooAction>;

export const CooTurn = z.object({
  /** 文章で返事を書けなかったときだけ（通常 null） */
  reply: z.string().max(12000).nullable(),
  /** CEO に質問して返事を待っているか */
  awaitingReply: z.boolean(),
  actions: z.array(CooAction).max(5),
});
export type CooTurn = z.infer<typeof CooTurn>;

export const PlanTask = z.object({
  key: z.string().regex(/^t\d{1,2}$/),
  title: z.string().max(80),
  spec: z.string().max(2000),
  assignee: z.string().max(30),
  dependsOn: z.array(z.string()).max(5),
  /** 触ってよい範囲（並行するタスクで重ねない） */
  paths: z.array(z.string().max(200)).max(20),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const COO_REPORT_CHANGES = ["none", "direction", "scope", "priority", "new_work", "stop"] as const;
export type CooReportChange = (typeof COO_REPORT_CHANGES)[number];

export const LeaderAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plan"),
    /** null は CEO と直接話して生まれた新しい仕事（このプロジェクトに新しい指示を作る） */
    instructionId: z.string().nullable(),
    newTitle: z.string().max(60).nullable(),
    tasks: z.array(PlanTask).min(1).max(6),
  }),
  z.object({ type: z.literal("answer_member"), sessionId: z.string(), message: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("resolve_conflict"), instructionId: z.string(), taskKey: z.string(), assignee: z.string().max(30) }),
  z.object({
    type: z.literal("report"),
    instructionId: z.string(),
    summary: z.string().min(1).max(8000),
    openIssues: z.array(z.string().max(300)).max(5),
  }),
  z.object({ type: z.literal("ask_coo"), instructionId: z.string().nullable(), question: z.string().min(1).max(1000) }),
]);
export type LeaderAction = z.infer<typeof LeaderAction>;

export const CooReport = z.object({
  summary: z.string().min(1).max(600),
  change: z.enum(COO_REPORT_CHANGES),
  instructionIds: z.array(z.string()).max(5),
});
export type CooReport = z.infer<typeof CooReport>;

export const LeaderTurn = z.object({
  reply: z.string().max(12000).nullable(),
  awaitingReply: z.boolean(),
  actions: z.array(LeaderAction).max(5),
  /** CEO の発言を受けたターンでは必ず書く（無ければ null）。D-78 */
  cooReport: CooReport.nullable(),
});
export type LeaderTurn = z.infer<typeof LeaderTurn>;

export const MemberOutput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("done"),
    summary: z.string().min(1).max(4000),
    artifacts: z.array(z.object({ path: z.string().max(400), title: z.string().max(80) })).max(10),
  }),
  z.object({ kind: z.literal("give_up"), reason: z.string().max(1000) }),
  z.object({ kind: z.literal("ask_leader"), question: z.string().min(1).max(1000) }),
]);
export type MemberOutput = z.infer<typeof MemberOutput>;

/**
 * MemberOutput の送る形（D-97）。道具の input_schema は最上位が type: "object" でなければならず、
 * discriminatedUnion をそのまま渡すと API が 400（tools.N.custom.input_schema.type: Field required）を返した（probe で確認）。
 * そこで --json-schema には 1 つの object（kind ＋ 種類ごとの項目を nullable）を渡し、受け取ったら MemberOutput に直して検査する。
 */
export const MemberOutputWire = z.object({
  kind: z.enum(["done", "give_up", "ask_leader"]),
  summary: z.string().max(4000).nullable().describe("kind=done のとき: やったことの要約"),
  artifacts: z
    .array(z.object({ path: z.string().max(400), title: z.string().max(80) }))
    .max(10)
    .nullable()
    .describe("kind=done のとき: 成果物（無ければ空の配列）"),
  reason: z.string().max(1000).nullable().describe("kind=give_up のとき: 諦めた理由"),
  question: z.string().max(1000).nullable().describe("kind=ask_leader のとき: リーダーへの質問"),
});
export type MemberOutputWire = z.infer<typeof MemberOutputWire>;

/** 送る形 → MemberOutput（kind に関係する項目だけを拾う。足りなければ MemberOutput の検査で落ちる） */
export function memberOutputFromWire(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "done":
      return { kind: "done", summary: v.summary, artifacts: v.artifacts ?? [] };
    case "give_up":
      return { kind: "give_up", reason: v.reason };
    case "ask_leader":
      return { kind: "ask_leader", question: v.question };
    default:
      return value;
  }
}

export const TURN_SCHEMAS = { coo: CooTurn, leader: LeaderTurn, member: MemberOutput } as const;
export type TurnOutput<R extends TurnRole> = z.infer<(typeof TURN_SCHEMAS)[R]>;

/** --json-schema に渡す形（最上位は必ず object） */
const WIRE_SCHEMAS = { coo: CooTurn, leader: LeaderTurn, member: MemberOutputWire } as const;

/**
 * --json-schema に渡す JSON Schema。Claude Code は最後に StructuredOutput の道具でこの形を返す。
 * input 側の形で出す（default を持たないので output と同じ）。
 */
export function turnJsonSchema(role: TurnRole): Record<string, unknown> {
  const schema = z.toJSONSchema(WIRE_SCHEMAS[role], { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export type ParsedTurn<R extends TurnRole> =
  | { ok: true; value: TurnOutput<R> }
  | { ok: false; error: string };

/** result.structured_output（または StructuredOutput の input）を検査する。違反はターンの失敗（5.8） */
export function parseTurnOutput<R extends TurnRole>(role: R, value: unknown): ParsedTurn<R> {
  if (value === undefined || value === null) return { ok: false, error: "structured_output がありません" };
  const input = role === "member" ? memberOutputFromWire(value) : value;
  const r = TURN_SCHEMAS[role].safeParse(input);
  if (r.success) return { ok: true, value: r.data as TurnOutput<R> };
  return { ok: false, error: z.prettifyError(r.error).slice(0, 2000) };
}

/** 秘書の発言で起きたターンでランナーが行わない行動（11.5、D-91） */
export const SECRETARY_BLOCKED_COO_ACTIONS = ["propose_project", "delegate"] as const satisfies readonly CooAction["type"][];
