// 秘書 bot の道具（DESIGN-v2 11.4、D-90・D-91）。MCP の tools/list・tools/call、HTTP API（/api/bot/v1/*）、OpenAPI が同じ定義を使う。
// 説明文は bot が正しく使えるよう日本語で書き、tools/list でそのまま返す。
// できないこと（道具が無い＝呼べない）: 承認・拒否の決定、指示の承認・差し戻し・取消・アーカイブ・削除、プロジェクトを立てる・作業場所の変更、
// リーダーやメンバーへの直接の連絡、トランスクリプト・差分・ファイルの中身の読み取り、設定・トークン・通知の変更。
import { z } from "zod";
import { InstructionPhaseSchema, InstructionStatusSchema, VerdictSchema, type BotScope } from "./models.ts";
import { LIMITS } from "./limits.ts";

// ───────────── MCP（11.2） ─────────────

/** 返すプロトコルの版。bot が別の版を求めたら、その版をそのまま返して同じ処理をする */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = { name: "baton", version: "2.0.0" } as const;
export const MCP_METHODS = ["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"] as const;

/** JSON-RPC のエラーコード */
export const MCP_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** トークンのスコープ外の道具 */
  forbidden: -32003,
  /** レート制限（data.retryAfter に秒。11.6） */
  rateLimited: -32029,
} as const;

// ───────────── 返す内容の部品 ─────────────

const QuotaWindow = z.object({ utilization: z.number().nullable(), resetsAt: z.number().nullable() });
const WorkspaceView = z.object({ kind: z.enum(["baton", "repo"]), repoName: z.string().optional() });
const Counts = z.object({
  running: z.int(),
  queued: z.int(),
  needsDecision: z.int(),
  review: z.int(),
  failed: z.int(),
  doneRecent: z.int(),
});
const ThreadAuthor = z.enum(["CEO", "COO", "リーダー", "秘書", "システム"]);

const OverviewOutput = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      goal: z.string(),
      workspace: WorkspaceView,
      counts: Counts,
      activeAgents: z.int(),
      lastActivityAt: z.number().nullable(),
    }),
  ),
  waitingForCeo: z.object({ approvals: z.int(), decisions: z.int(), reviews: z.int(), questions: z.int() }),
  coo: z.object({
    lastMessage: z.object({ author: ThreadAuthor, body: z.string(), at: z.number() }).nullable(),
    awaitingReply: z.boolean(),
  }),
  quota: z.object({ fiveHour: QuotaWindow, sevenDay: QuotaWindow }),
});

const ListProjectsOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      goal: z.string(),
      workspace: WorkspaceView,
      team: z.array(z.object({ name: z.string(), role: z.enum(["leader", "member"]), profile: z.string().nullable() })),
      counts: Counts,
    }),
  ),
});

const GetProjectOutput = z.object({
  project: z.object({ id: z.string(), name: z.string(), goal: z.string(), workspace: WorkspaceView }),
  openInstructions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: InstructionStatusSchema,
      phase: InstructionPhaseSchema.nullable(),
      activity: z.string().nullable(),
      updatedAt: z.number(),
    }),
  ),
  leaderThread: z.object({ lastMessages: z.array(z.object({ author: ThreadAuthor, body: z.string(), at: z.number() })).max(5) }),
});

const WaitingKind = z.enum(["approval", "decision", "review", "question"]);
const ListWaitingOutput = z.object({
  items: z.array(
    z.object({
      kind: WaitingKind,
      id: z.string(),
      title: z.string(),
      projectName: z.string().nullable(),
      askedBy: z.string(),
      summary: z.string(),
      since: z.number(),
      suggestion: z.object({ text: z.string(), verdict: VerdictSchema.nullable() }).optional(),
    }),
  ),
});

const GetInstructionOutput = z.object({
  id: z.string(),
  title: z.string(),
  status: InstructionStatusSchema,
  phase: InstructionPhaseSchema.nullable(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  report: z.string().optional(),
  tasks: z.array(z.object({ title: z.string(), assignee: z.string().nullable(), status: z.string() })),
  branch: z.string().optional(),
  lastActivity: z.string().nullable(),
  createdAt: z.number(),
});

const ReadCooThreadOutput = z.object({
  items: z.array(
    z.object({
      seq: z.int(),
      author: ThreadAuthor,
      body: z.string().max(LIMITS.broadcastMaxChars),
      at: z.number(),
      instructionId: z.string().optional(),
    }),
  ),
});

// ───────────── 道具 ─────────────

export type BotToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  name: string;
  scope: BotScope;
  description: string;
  input: I;
  output: O;
  /** HTTP API の対応（1 対 1。12.4） */
  http: { method: "GET" | "POST"; path: string };
};

function tool<I extends z.ZodType, O extends z.ZodType>(def: BotToolDef<I, O>): BotToolDef<I, O> {
  return def;
}

export const BOT_TOOLS = {
  baton_overview: tool({
    name: "baton_overview",
    scope: "read",
    description:
      "Baton（CEO の AI チーム）の全体の様子を返します。進行中のプロジェクト、CEO の返事を待っているもの（承認・判断・確認・質問）の数、COO の最新の発言、サブスク枠の使用率です。まずこれを呼んでください。",
    input: z.object({}),
    output: OverviewOutput,
    http: { method: "GET", path: "/api/bot/v1/overview" },
  }),
  baton_list_projects: tool({
    name: "baton_list_projects",
    scope: "read",
    description: "プロジェクトの一覧を返します。目的・作業場所・チーム・指示の件数が分かります。",
    input: z.object({ status: z.enum(["active", "all"]).optional().describe("active（既定）は進行中だけ、all はアーカイブも含めます") }),
    output: ListProjectsOutput,
    http: { method: "GET", path: "/api/bot/v1/projects" },
  }),
  baton_get_project: tool({
    name: "baton_get_project",
    scope: "read",
    description: "1 つのプロジェクトの詳しい様子を返します。進行中の指示（カード）と、リーダーとの最近のやりとりが分かります。",
    input: z.object({ projectId: z.string().min(1).describe("プロジェクトの ID（baton_list_projects で分かります）") }),
    output: GetProjectOutput,
    http: { method: "GET", path: "/api/bot/v1/projects/{projectId}" },
  }),
  baton_list_waiting: tool({
    name: "baton_list_waiting",
    scope: "read",
    description:
      "CEO の返事や確認を待っているものの一覧を返します。承認待ち（危ない操作の許可）、判断待ち、確認待ち（終わった仕事）、COO・リーダーからの質問です。あなたはこれらを決定できません。CEO に伝えるか、回答案を出してください。",
    input: z.object({ kind: WaitingKind.optional().describe("種類で絞り込みます。省略するとすべて") }),
    output: ListWaitingOutput,
    http: { method: "GET", path: "/api/bot/v1/waiting" },
  }),
  baton_get_instruction: tool({
    name: "baton_get_instruction",
    scope: "read",
    description:
      "1 つの指示（AI チームの仕事のまとまり）の状態と、COO の報告の要約を返します。ファイルの中身や作業の細かい記録は返しません。",
    input: z.object({ instructionId: z.string().min(1).describe("指示の ID") }),
    output: GetInstructionOutput,
    http: { method: "GET", path: "/api/bot/v1/instructions/{instructionId}" },
  }),
  baton_read_coo_thread: tool({
    name: "baton_read_coo_thread",
    scope: "read",
    description:
      "CEO と COO の会話を新しい順に返します。リーダーとの会話は含みません（必要な部分は「リーダーからの報告」として COO の会話に入っています）。",
    input: z.object({
      limit: z.int().min(1).max(LIMITS.botReadLimitMax).optional().describe("件数（1〜30、既定 10）"),
      beforeSeq: z.int().min(0).optional().describe("この番号より前を返します（続きを読むとき）"),
    }),
    output: ReadCooThreadOutput,
    http: { method: "GET", path: "/api/bot/v1/coo-thread" },
  }),
  baton_send_to_coo: tool({
    name: "baton_send_to_coo",
    scope: "message",
    description:
      "CEO の秘書として COO にメッセージを送ります。会話には「秘書から」と表示されます。COO は CEO 本人の指示とは区別して扱い、大きな仕事を始める前には CEO に確かめます。急ぎでない連絡・状況の確認・CEO から預かった依頼の取り次ぎに使ってください。返事は baton_read_coo_thread で読めます。",
    input: z.object({
      message: z.string().trim().min(1).max(LIMITS.botMessageMaxChars).describe("COO に送る文（1〜2,000 文字）"),
      projectId: z.string().optional().describe("関係するプロジェクトの ID（あれば）"),
      requestId: z.string().min(1).max(100).describe("重複防止の ID。同じ ID で送り直しても 1 回だけ届きます"),
    }),
    output: z.object({ messageId: z.string(), seq: z.int(), note: z.string() }),
    http: { method: "POST", path: "/api/bot/v1/coo-thread/messages" },
  }),
  baton_propose_answer: tool({
    name: "baton_propose_answer",
    scope: "propose",
    description:
      "承認待ち・判断待ちに、CEO への回答案を添えます。決定はしません。CEO の画面に「秘書の案」として表示され、CEO が最終的に決めます。",
    input: z.object({
      targetId: z.string().min(1).describe("承認・判断の ID（baton_list_waiting で分かります）"),
      proposal: z.string().trim().min(1).max(1000).describe("回答案（1〜1,000 文字）"),
      verdict: VerdictSchema.optional().describe("承認待ちなら allow（許可がよさそう）か deny（拒否がよさそう）"),
    }),
    output: z.object({ ok: z.literal(true), note: z.string() }),
    http: { method: "POST", path: "/api/bot/v1/proposals" },
  }),
} as const;

export type BotToolName = keyof typeof BOT_TOOLS;
export const BOT_TOOL_NAMES = Object.keys(BOT_TOOLS) as BotToolName[];
export type BotToolInput<N extends BotToolName> = z.infer<(typeof BOT_TOOLS)[N]["input"]>;
export type BotToolOutput<N extends BotToolName> = z.infer<(typeof BOT_TOOLS)[N]["output"]>;

/** トークンのスコープで使える道具（スコープ外は tools/list に出さない。tools/call で拒否） */
export function botToolsForScopes(scopes: readonly BotScope[]): BotToolName[] {
  return BOT_TOOL_NAMES.filter((n) => scopes.includes(BOT_TOOLS[n].scope));
}

export function isBotToolName(name: string): name is BotToolName {
  return Object.hasOwn(BOT_TOOLS, name);
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/** MCP の tools/list の 1 件 */
export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: false; openWorldHint: false };
};

export function mcpToolDescriptor(name: BotToolName): McpToolDescriptor {
  const t = BOT_TOOLS[name];
  return {
    name: t.name,
    description: t.description,
    inputSchema: jsonSchema(t.input, "input"),
    outputSchema: jsonSchema(t.output, "output"),
    annotations: { readOnlyHint: t.scope === "read", destructiveHint: false, openWorldHint: false },
  };
}

export function mcpToolList(scopes: readonly BotScope[]): McpToolDescriptor[] {
  return botToolsForScopes(scopes).map(mcpToolDescriptor);
}

/** tools/call の結果（content は人が読める短い日本語の要約、structuredContent は JSON） */
export type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function mcpToolResult(summary: string, structured: Record<string, unknown>): McpToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent: structured };
}

export function mcpToolError(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** OpenAPI 3.1（GET /api/bot/v1/openapi.json）。道具 1 つ＝エンドポイント 1 つ */
export function botOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const name of BOT_TOOL_NAMES) {
    const t = BOT_TOOLS[name];
    const input = jsonSchema(t.input, "input");
    const props = (input.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((input.required as string[] | undefined) ?? []);
    const pathParams = [...t.http.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const op: Record<string, unknown> = {
      operationId: name,
      summary: t.description,
      "x-baton-scope": t.scope,
      security: [{ bearer: [] }],
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: jsonSchema(t.output, "output") } } },
        "401": { description: "トークンが無い・誤り・失効" },
        "403": { description: "スコープ外" },
        "429": { description: "レート制限" },
      },
    };
    const parameters: Record<string, unknown>[] = pathParams.map((p) => ({ name: p, in: "path", required: true, schema: props[p] ?? { type: "string" } }));
    if (t.http.method === "GET") {
      for (const [k, v] of Object.entries(props)) {
        if (pathParams.includes(k)) continue;
        parameters.push({ name: k, in: "query", required: required.has(k), schema: v });
      }
    } else {
      op.requestBody = { required: true, content: { "application/json": { schema: input } } };
    }
    if (parameters.length) op.parameters = parameters;
    paths[t.http.path] = { ...(paths[t.http.path] ?? {}), [t.http.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Baton 秘書 bot API", version: MCP_SERVER_INFO.version, description: "MCP（POST /mcp）と同じ処理を呼ぶ HTTP API です。" },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

