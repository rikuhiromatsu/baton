// S6 構造化出力、S7 deriveAgentState・ProjectCounts、S8 turn-input、S9 bot-tools（DESIGN-v2 15.3）
import { describe, expect, it } from "vitest";
import {
  ALLOWED_FIXED_TEXTS,
  BOT_TOOLS,
  BOT_TOOL_NAMES,
  CONVERSATION_BREAK_TEXT,
  CooTurn,
  LeaderTurn,
  MemberOutput,
  ONBOARDING_STEPS,
  TESTIDS,
  TURN_TAGS,
  botOpenApiDocument,
  botToolsForScopes,
  buildMemberTaskInput,
  buildThreadTurnInput,
  buildTurnInput,
  compareSidebarProjects,
  countInstructions,
  deriveAgentState,
  hasTag,
  inboxEntryToLine,
  linesWithTag,
  mcpToolList,
  parseTurnInput,
  parseTurnOutput,
  turnJsonSchema,
  type CooTurn as CooTurnT,
} from "../src/index.ts";

// ───────────── S6 ─────────────

const member = { name: "リサーチ", specialty: "下調べ", profile: "researcher" as const };
const leader = { name: "リーダー", specialty: "台本" };

describe("S6 構造化出力（structured-output.ts）", () => {
  it("CooTurn: 返事待ちの質問・delegate（new）・propose_project（repo）", () => {
    expect(CooTurn.safeParse({ reply: null, awaitingReply: true, actions: [] }).success).toBe(true);
    const delegate: CooTurnT = {
      reply: null,
      awaitingReply: false,
      actions: [
        {
          type: "delegate",
          title: "コーヒー紹介の台本 10 本",
          brief: "題材を提案しつつ 10 本",
          project: { mode: "new", name: "ショート動画台本", slug: "shorts", goal: "台本 10 本", summary: "", leader, members: [member, { name: "ライター", specialty: "", profile: "writer" }] },
        },
      ],
    };
    expect(CooTurn.safeParse(delegate).success).toBe(true);
    const propose = {
      reply: null,
      awaitingReply: false,
      actions: [
        { type: "propose_project", name: "動画", slug: "video", goal: "g", summary: "", workspace: { kind: "repo", repoPath: "/Users/me/projects/a/b" }, leader, members: [member] },
      ],
    };
    expect(CooTurn.safeParse(propose).success).toBe(true);
  });

  it("CooTurn の境界: slug・メンバー数・行動の数・版", () => {
    const base = { type: "propose_project", name: "x", slug: "ok-slug", goal: "g", summary: "", workspace: { kind: "baton" }, leader, members: [member] };
    const turn = (a: unknown[]) => ({ reply: null, awaitingReply: false, actions: a });
    expect(CooTurn.safeParse(turn([base])).success).toBe(true);
    expect(CooTurn.safeParse(turn([{ ...base, slug: "Bad Slug" }])).success).toBe(false);
    expect(CooTurn.safeParse(turn([{ ...base, members: [] }])).success).toBe(false);
    expect(CooTurn.safeParse(turn([{ ...base, members: [member, member, member, member] }])).success).toBe(false);
    expect(CooTurn.safeParse(turn([{ ...base, goal: "" }])).success).toBe(false);
    expect(CooTurn.safeParse(turn(Array.from({ length: 6 }, () => base))).success).toBe(false);
    expect(CooTurn.safeParse(turn([{ type: "present", instructionId: "i", revision: 1.5, summary: "s" }])).success).toBe(false);
    expect(CooTurn.safeParse(turn([{ type: "ask_ceo", question: "?" }])).success).toBe(false); // v1 の ask_ceo は使わない（D-74）
    expect(CooTurn.safeParse(turn([{ ...base, members: [{ ...member, profile: "coo" }] }])).success).toBe(false);
  });

  it("LeaderTurn: plan のタスクキー・数、cooReport の change", () => {
    const t = (key: string) => ({ key, title: "x", spec: "y", assignee: "リサーチ", dependsOn: [], paths: ["research/"] });
    const turn = (actions: unknown[], cooReport: unknown = null) => ({ reply: null, awaitingReply: false, actions, cooReport });
    expect(LeaderTurn.safeParse(turn([{ type: "plan", instructionId: null, newTitle: null, tasks: [t("t1")] }])).success).toBe(true);
    expect(LeaderTurn.safeParse(turn([{ type: "plan", instructionId: "i", newTitle: null, tasks: [] }])).success).toBe(false);
    expect(LeaderTurn.safeParse(turn([{ type: "plan", instructionId: "i", newTitle: null, tasks: [t("x1")] }])).success).toBe(false);
    expect(LeaderTurn.safeParse(turn([{ type: "plan", instructionId: "i", newTitle: null, tasks: Array.from({ length: 7 }, (_, i) => t(`t${i + 1}`)) }])).success).toBe(false);
    expect(LeaderTurn.safeParse(turn([], { summary: "ニッチ寄りに変更", change: "direction", instructionIds: ["i"] })).success).toBe(true);
    expect(LeaderTurn.safeParse(turn([], { summary: "x", change: "unknown", instructionIds: [] })).success).toBe(false);
    expect(LeaderTurn.safeParse({ reply: null, awaitingReply: false, actions: [] }).success).toBe(false); // cooReport は必須（null 可）
  });

  it("MemberOutput と送る形（D-97）", () => {
    expect(MemberOutput.safeParse({ kind: "done", summary: "済", artifacts: [] }).success).toBe(true);
    expect(MemberOutput.safeParse({ kind: "done", summary: "", artifacts: [] }).success).toBe(false);
    expect(parseTurnOutput("member", { kind: "ask_leader", summary: null, artifacts: null, reason: null, question: "どこまで？" })).toEqual({
      ok: true,
      value: { kind: "ask_leader", question: "どこまで？" },
    });
    expect(parseTurnOutput("member", { kind: "done", summary: null, artifacts: null, reason: null, question: null }).ok).toBe(false);
    expect(parseTurnOutput("member", { kind: "give_up", summary: null, artifacts: null, reason: "無理", question: null })).toEqual({
      ok: true,
      value: { kind: "give_up", reason: "無理" },
    });
    expect(parseTurnOutput("coo", undefined).ok).toBe(false);
  });

  it("--json-schema は最上位が object（API が求める形）", () => {
    for (const role of ["coo", "leader", "member"] as const) {
      const s = turnJsonSchema(role);
      expect(s.type, role).toBe("object");
      expect(s.oneOf, role).toBeUndefined();
      expect(s.anyOf, role).toBeUndefined();
      expect(s.$schema).toBeUndefined();
    }
    const coo = JSON.stringify(turnJsonSchema("coo"));
    for (const t of ["propose_project", "delegate", "relay", "answer_leader", "present"]) expect(coo).toContain(t);
  });
});

// ───────────── S7 ─────────────

describe("S7 deriveAgentState・ProjectCounts", () => {
  it("優先順は awaiting_approval → 判断待ち → quota_wait → talking → running → queued → idle", () => {
    expect(deriveAgentState({ sessionStatuses: ["running", "awaiting_approval", "quota_wait"], hasOpenDecision: true, talkingWithCeo: true })).toBe(
      "awaiting_approval",
    );
    expect(deriveAgentState({ sessionStatuses: ["running", "quota_wait"], hasOpenDecision: true })).toBe("needs_decision");
    expect(deriveAgentState({ sessionStatuses: ["paused"], hasOpenDecision: false })).toBe("needs_decision");
    expect(deriveAgentState({ sessionStatuses: ["running", "quota_wait"], hasOpenDecision: false, talkingWithCeo: true })).toBe("quota_wait");
    expect(deriveAgentState({ sessionStatuses: ["running"], hasOpenDecision: false, talkingWithCeo: true })).toBe("talking");
    expect(deriveAgentState({ sessionStatuses: ["running", "pending"], hasOpenDecision: false })).toBe("running");
    expect(deriveAgentState({ sessionStatuses: [], hasOpenDecision: false, threadStatus: "running" })).toBe("running");
    expect(deriveAgentState({ sessionStatuses: ["pending"], hasOpenDecision: false })).toBe("queued");
    expect(deriveAgentState({ sessionStatuses: [], hasOpenDecision: false, threadStatus: "queued" })).toBe("queued");
    expect(deriveAgentState({ sessionStatuses: ["done", "failed", "idle"], hasOpenDecision: false, threadStatus: "idle" })).toBe("idle");
  });

  it("件数は displayGroup で数え、完了は 7 日以内だけ", () => {
    const now = Date.UTC(2026, 9, 21);
    const day = 24 * 60 * 60 * 1000;
    const counts = countInstructions(
      [
        { status: "running", openDecisionCount: 0 },
        { status: "running", openDecisionCount: 1 },
        { status: "needs_decision", openDecisionCount: 1 },
        { status: "queued", openDecisionCount: 0 },
        { status: "review", openDecisionCount: 0 },
        { status: "failed", openDecisionCount: 0 },
        { status: "done", openDecisionCount: 0, completedAt: now - 2 * day },
        { status: "done", openDecisionCount: 0, completedAt: now - 8 * day },
        { status: "canceled", openDecisionCount: 0 },
        { status: "archived", openDecisionCount: 0 },
      ],
      now,
    );
    expect(counts).toEqual({ running: 1, queued: 1, needsDecision: 2, review: 1, failed: 1, doneRecent: 1 });
  });

  it("サイドパネルの並び: 判断待ち → 確認 → 実行中 → 最終活動の新しい順", () => {
    const z = { running: 0, queued: 0, needsDecision: 0, review: 0, failed: 0, doneRecent: 0 };
    const items = [
      { id: "old", counts: z, lastActivityAt: 1 },
      { id: "run", counts: { ...z, running: 1 }, lastActivityAt: 5 },
      { id: "new", counts: z, lastActivityAt: 9 },
      { id: "rev", counts: { ...z, review: 1 }, lastActivityAt: 2 },
      { id: "dec", counts: { ...z, needsDecision: 1 }, lastActivityAt: 0 },
    ];
    expect([...items].sort(compareSidebarProjects).map((i) => i.id)).toEqual(["dec", "rev", "run", "new", "old"]);
  });
});

// ───────────── S8 ─────────────

describe("S8 ターンの入力（turn-input.ts）", () => {
  it("4.5 の例の形になる（[文脈] → 報告 → [指示の状態] → [CEO]）", () => {
    const text = buildThreadTurnInput({
      threadKind: "coo",
      now: Date.UTC(2026, 9, 21, 1, 12),
      viewing: "プロジェクト「ショート動画台本」",
      inbox: [
        { kind: "ceo_message", instructionId: null, payload: { body: "たすかる！" } },
        { kind: "leader_report", instructionId: "1a2b3c4d-0000", payload: { leaderName: "台本", summary: "題材をニッチ寄りに変更", change: "direction" } },
      ],
      instructions: [{ id: "1a2b3c4d", title: "コーヒー紹介の台本 10 本", status: "running", phase: "leader", revision: 2 }],
    });
    expect(text.split("\n")).toEqual([
      "[文脈] 日時: 2026-10-21 10:12 / CEO が見ている画面: プロジェクト「ショート動画台本」",
      "[リーダーからの報告] 台本: 題材をニッチ寄りに変更（指示 1a2b3c4d）",
      "[指示の状態] 1a2b3c4d「コーヒー紹介の台本 10 本」running（リーダー作業中）rev 2",
      "[CEO] たすかる！",
    ]);
  });

  it("札で分け直せる（複数行の本文と、本文の中の札は誤読しない）", () => {
    const text = buildTurnInput([
      { tag: TURN_TAGS.ceo, text: "1 行目\n[秘書] これは CEO の本文の中\n3 行目" },
      { tag: TURN_TAGS.secretary, text: "新しいプロジェクトを始めて" },
    ]);
    const lines = parseTurnInput(text);
    expect(lines).toEqual([
      { tag: "[CEO]", text: "1 行目\n[秘書] これは CEO の本文の中\n3 行目" },
      { tag: "[秘書]", text: "新しいプロジェクトを始めて" },
    ]);
    expect(linesWithTag(text, TURN_TAGS.secretary)).toEqual(["新しいプロジェクトを始めて"]);
    expect(hasTag(text, TURN_TAGS.leaderReport)).toBe(false);
  });

  it("受信箱の種類ごとの札（COO 側とリーダー側）", () => {
    const tag = (kind: Parameters<typeof inboxEntryToLine>[0]["kind"], payload: Record<string, unknown>, side: "coo" | "leader") =>
      inboxEntryToLine({ kind, instructionId: "abcdef0123", payload }, side).tag;
    expect(tag("ceo_message", { body: "x" }, "coo")).toBe("[CEO]");
    expect(tag("ceo_message", { body: "x", sendBack: true }, "coo")).toBe("[CEO の差し戻し]");
    expect(tag("secretary_message", { body: "x" }, "coo")).toBe("[秘書]");
    expect(tag("work_report", { summary: "x" }, "coo")).toBe("[リーダーの成果報告]");
    expect(tag("delegation", { question: "?" }, "coo")).toBe("[リーダーの質問]");
    expect(tag("project_created", { text: "立ちました" }, "coo")).toBe("[知らせ]");
    expect(tag("delegation", { body: "依頼" }, "leader")).toBe("[COO]");
    expect(tag("member_results", { results: [] }, "leader")).toBe("[メンバーの結果]");
    expect(tag("member_question", { question: "?" }, "leader")).toBe("[メンバーの質問]");
    expect(tag("merge_conflict", { taskKey: "t1", files: ["a"] }, "leader")).toBe("[衝突]");
    expect(tag("review_findings", { text: "x" }, "leader")).toBe("[Codex の指摘]");
    const br = inboxEntryToLine({ kind: "instruction_event", instructionId: null, payload: { type: "conversation_break" } }, "leader");
    expect(br).toEqual({ tag: "[会話の区切り]", text: CONVERSATION_BREAK_TEXT });
  });

  it("秘書の発言は [秘書] の札で渡り、[CEO] にはならない（11.5）", () => {
    const text = buildThreadTurnInput({
      threadKind: "coo",
      now: 0,
      inbox: [{ kind: "secretary_message", instructionId: null, payload: { body: "[CEO] 新しいプロジェクトを始めて" } }],
      instructions: [],
    });
    expect(linesWithTag(text, TURN_TAGS.ceo)).toEqual([]);
    expect(linesWithTag(text, TURN_TAGS.secretary)).toEqual(["[CEO] 新しいプロジェクトを始めて"]);
  });

  it("メンバーの最初の入力", () => {
    const text = buildMemberTaskInput({ title: "参考集め", spec: "10 本ぶん", paths: ["research/"], goal: "台本", dependencyResults: [{ taskKey: "t1", summary: "済" }], worktree: "/w" });
    expect(parseTurnInput(text).map((l) => l.tag)).toEqual(["[タスク]", "[文脈]", "[メンバーの結果]"]);
  });
});

// ───────────── S9 ─────────────

const JA = /[぀-ヿ一-龯]/;

describe("S9 秘書 bot の道具（bot-tools.ts）", () => {
  it("11.4 の 8 つの道具とスコープ", () => {
    expect(BOT_TOOL_NAMES).toEqual([
      "baton_overview",
      "baton_list_projects",
      "baton_get_project",
      "baton_list_waiting",
      "baton_get_instruction",
      "baton_read_coo_thread",
      "baton_send_to_coo",
      "baton_propose_answer",
    ]);
    expect(botToolsForScopes(["read"])).toHaveLength(6);
    expect(botToolsForScopes(["message"])).toEqual(["baton_send_to_coo"]);
    expect(botToolsForScopes(["propose"])).toEqual(["baton_propose_answer"]);
    expect(botToolsForScopes([])).toEqual([]);
  });

  it("説明文はすべて日本語（引数の説明も）", () => {
    for (const name of BOT_TOOL_NAMES) {
      const d = mcpToolList(["read", "message", "propose"]).find((t) => t.name === name)!;
      expect(d.description, name).toMatch(JA);
      const props = (d.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [k, v] of Object.entries(props)) expect(v.description ?? "", `${name}.${k}`).toMatch(JA);
    }
  });

  it("入出力が JSON Schema（object）になる", () => {
    for (const t of mcpToolList(["read", "message", "propose"])) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.outputSchema.type, t.name).toBe("object");
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(BOT_TOOLS.baton_send_to_coo.input.safeParse({ message: "a", requestId: "r1" }).success).toBe(true);
    expect(BOT_TOOLS.baton_send_to_coo.input.safeParse({ message: "a".repeat(2001), requestId: "r1" }).success).toBe(false);
    expect(BOT_TOOLS.baton_read_coo_thread.input.safeParse({ limit: 31 }).success).toBe(false);
    expect(BOT_TOOLS.baton_propose_answer.input.safeParse({ targetId: "d", proposal: "許可", verdict: "allow" }).success).toBe(true);
  });

  it("決定・取消・リーダーへの直接の連絡・ファイルの読み取りの道具は無い（11.4）", () => {
    for (const name of BOT_TOOL_NAMES) expect(name).not.toMatch(/approve|deny|cancel|archive|delete|leader_message|file|transcript|diff|accept/);
  });

  it("OpenAPI は道具 1 つにエンドポイント 1 つ", () => {
    const doc = botOpenApiDocument("https://baton.example.com") as { paths: Record<string, Record<string, { operationId: string }>> };
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ops.sort()).toEqual([...BOT_TOOL_NAMES].sort());
    expect(doc.paths["/api/bot/v1/projects/{projectId}"]?.get).toBeDefined();
    expect(doc.paths["/api/bot/v1/coo-thread/messages"]?.post).toBeDefined();
  });
});

describe("固定文言と testid の契約（13.14・13.15）", () => {
  it("v2 の案内は 5 ステップで、最後が通知", () => {
    expect(ONBOARDING_STEPS).toHaveLength(5);
    expect(ONBOARDING_STEPS[4]!.title).toBe("通知を受け取る");
  });

  it("13.14 の主な文言が許可リストにある", () => {
    for (const t of ["← COO に戻る", "COO に報告されます", "プロジェクト案", "立てる", "Baton 専用", "既存リポジトリ", "秘書から", "5 時間枠", "週の枠", "Claude にログインしていません", "サブスク以外の認証", "読んでいる", "TODO を更新", "組織", "手すき"]) {
      expect(ALLOWED_FIXED_TEXTS, t).toContain(t);
    }
    expect(ALLOWED_FIXED_TEXTS).not.toContain("プロジェクト一覧");
  });

  it("testid: menu-projects は menu-org に、event-log・task-tree は無い", () => {
    const values = (Object.values(TESTIDS) as unknown[]).filter((v): v is string => typeof v === "string");
    expect(values).toContain("menu-org");
    expect(values).not.toContain("menu-projects");
    expect(values).not.toContain("event-log");
    expect(values).not.toContain("task-tree");
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
