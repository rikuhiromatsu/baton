// W40〜W45 秘書 bot（DESIGN-v2 11 章・D-90・D-91）
// W40 認証（トークン無し・誤り・失効で 401、Cookie だけでは通らない、CORS なし）、W41 スコープ、W42 JSON-RPC の形、
// W43 各道具の返す内容（秘書の発言・回答案は決定しない）、W44 レート制限・監査・トークンの発行と失効、W45 HTTP 層が MCP と同じ結果・OpenAPI
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BOT_TOOL_NAMES, MCP_PROTOCOL_VERSION, type BotAuditItem, type BotTokenView, type Decision, type McpToolDescriptor } from "@baton/shared";
import {
  browser,
  call,
  claim,
  clearWork,
  createProject,
  createSession,
  insertInstruction,
  login,
  membersInstruction,
  registerRunner,
  runner,
  type TestSession,
} from "./helpers.ts";

async function issue(s: TestSession, scopes: string[] = ["read", "message", "propose"], name = "Grok 秘書") {
  const res = await browser(s, "/api/bot-tokens", { body: { name, scopes } });
  if (res.status !== 201) throw new Error(`issue ${res.status} ${await res.text()}`);
  return (await res.json()) as { token: string; item: BotTokenView };
}

let rpcId = 0;
async function mcp(token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
  return res;
}
async function rpc<T = Record<string, unknown>>(token: string, method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string; data?: Record<string, unknown> } }> {
  const res = await mcp(token, method, params);
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: T; error?: { code: number; message: string; data?: Record<string, unknown> } };
}
async function tool<T = Record<string, unknown>>(token: string, name: string, args: Record<string, unknown> = {}) {
  return rpc<{ content: { type: string; text: string }[]; structuredContent: T; isError?: boolean }>(token, "tools/call", { name, arguments: args });
}
const http = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  call(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe("W40 認証", () => {
  it("トークン無し・誤り・失効は 401（MCP・HTTP とも）。Cookie だけでは通らない。CORS のヘッダは返さない", async () => {
    const s = await login();
    const { token, item } = await issue(s);
    expect((await mcp(null, "ping")).status).toBe(401);
    expect((await mcp("btn_bot_wrong", "ping")).status).toBe(401);
    expect((await mcp("not-a-bot-token", "ping")).status).toBe(401);
    const ok = await mcp(token, "ping");
    expect(ok.status).toBe(200);
    // Bearer の無いトークンだけでも通る（xAI の authorization の入れ方に依らない）。他のスキームは通らない
    expect((await mcp(null, "ping", undefined, { Authorization: token })).status).toBe(200);
    expect((await mcp(null, "ping", undefined, { Authorization: `Basic ${token}` })).status).toBe(401);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const cookieOnly = await call("/mcp", { method: "POST", headers: { Cookie: s.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(cookieOnly.status).toBe(401);
    expect((await call("/api/bot/v1/overview", { headers: { Cookie: s.cookie } })).status).toBe(401);
    // ランナーのトークンも通らない
    const r = await registerRunner();
    expect((await mcp(r.token, "ping")).status).toBe(401);
    // 失効したら次の呼び出しから 401
    expect((await browser(s, `/api/bot-tokens/${item.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await mcp(token, "ping")).status).toBe(401);
    expect((await http(token, "/api/bot/v1/overview")).status).toBe(401);
    // GET は 405（SSE の継続ストリームは返さない）
    const { token: t2 } = await issue(s);
    const get = await call("/mcp", { headers: { Authorization: `Bearer ${t2}` } });
    expect(get.status).toBe(405);
  });
});

describe("W41 スコープ", () => {
  it("スコープ外の道具は tools/list に出ず、tools/call は拒否（HTTP は 403）", async () => {
    const s = await login();
    const { token } = await issue(s, ["read"]);
    const list = await rpc<{ tools: McpToolDescriptor[] }>(token, "tools/list");
    const names = list.result!.tools.map((t) => t.name);
    expect(names).toEqual(BOT_TOOL_NAMES.filter((n) => !["baton_send_to_coo", "baton_propose_answer"].includes(n)));
    const denied = await tool(token, "baton_send_to_coo", { message: "x", requestId: "r1" });
    expect(denied.error?.code).toBe(-32003);
    expect((await http(token, "/api/bot/v1/coo-thread/messages", { body: { message: "x", requestId: "r1" } })).status).toBe(403);
    const { token: msgOnly } = await issue(s, ["message"]);
    expect((await tool(msgOnly, "baton_overview")).error?.code).toBe(-32003);
    // 決定に当たる道具はそもそも無い
    expect((await tool(token, "baton_approve", {})).error?.code).toBe(-32602);
  });
});

describe("W42 JSON-RPC の形", () => {
  it("initialize（版はそのまま返す）・notifications/initialized（202）・tools/list・ping・未知のメソッド・パースエラー・バッチ", async () => {
    const s = await login();
    const { token } = await issue(s);
    const init = await rpc<{ protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } }>(token, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "grok", version: "1" },
    });
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "baton" } });
    expect((await rpc<{ protocolVersion: string }>(token, "initialize", {})).result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    const note = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    expect(note.headers.get("Mcp-Session-Id")).toBeNull();
    const list = await rpc<{ tools: McpToolDescriptor[] }>(token, "tools/list");
    expect(list.result!.tools).toHaveLength(BOT_TOOL_NAMES.length);
    for (const t of list.result!.tools) {
      expect(t.description).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(await rpc(token, "ping")).toMatchObject({ result: {} });
    expect((await rpc(token, "resources/list")).error?.code).toBe(-32601);
    const bad = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const invalid = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: 1, method: "ping" }) });
    expect(((await invalid.json()) as { error: { code: number } }).error.code).toBe(-32600);
    const batch = await call("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "b", method: "tools/list" }]),
    });
    const out = (await batch.json()) as { id: string }[];
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    // 引数の誤りは -32602
    expect((await tool(token, "baton_get_project", {})).error?.code).toBe(-32602);
  });
});

describe("W43 道具の返す内容", () => {
  it("overview・list_projects・get_project・list_waiting・get_instruction・read_coo_thread", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const { token } = await issue(s);
    const p = await createProject(r, undefined, "台本");
    const a = await membersInstruction(r, p.project.id);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id });
    const approval = (await (await runner(r, "/api/runner/approvals", { body: { id: crypto.randomUUID(), instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: p.memberIds[0], toolName: "Bash", toolInput: {}, toolUseId: null, question: "npm install zod" } })).json()) as Decision;
    const review = await insertInstruction(s.userId, { status: "review", projectId: p.project.id, title: "確認待ち" });
    await env.DB.prepare("UPDATE instructions SET result_summary = '10 本の案' WHERE id = ?").bind(review).run();
    await runner(r, "/api/runner/threads/thread-coo/messages", {
      body: { id: crypto.randomUUID(), authorKind: "coo", authorAgentId: null, kind: "chat", body: "なんの動画ですか？", instructionId: null, sessionId: null, ref: {}, status: "complete", notify: true },
    });
    await browser(s, "/api/threads/thread-coo/messages", { body: { clientId: crypto.randomUUID(), body: "コーヒー紹介のやつです" } });
    await env.DB.prepare("UPDATE threads SET awaiting_reply = 1 WHERE id = 'thread-coo'").run();

    const ov = await tool<{ projects: { id: string; counts: { needsDecision: number; review: number } }[]; waitingForCeo: Record<string, number>; coo: { lastMessage: { author: string; body: string } | null; awaitingReply: boolean }; quota: unknown }>(token, "baton_overview");
    expect(ov.result!.content[0]!.text).toContain("承認 1");
    const sc = ov.result!.structuredContent;
    expect(sc.waitingForCeo).toMatchObject({ approvals: 1, reviews: 1, questions: 1 });
    expect(sc.coo).toEqual({ lastMessage: expect.objectContaining({ author: "CEO", body: "コーヒー紹介のやつです" }), awaitingReply: true });
    expect(sc.projects.find((x) => x.id === p.project.id)?.counts).toMatchObject({ needsDecision: 1, review: 1 });

    const lp = await tool<{ items: { id: string; team: { name: string; role: string; profile: string | null }[]; workspace: { kind: string } }[] }>(token, "baton_list_projects");
    expect(lp.result!.structuredContent.items.find((x) => x.id === p.project.id)).toMatchObject({ workspace: { kind: "baton" }, team: expect.arrayContaining([{ name: "リサーチ", role: "member", profile: "researcher" }]) });

    const gp = await tool<{ openInstructions: { id: string }[] }>(token, "baton_get_project", { projectId: p.project.id });
    expect(gp.result!.structuredContent.openInstructions.map((x) => x.id).sort()).toEqual([a.id, review].sort());
    expect((await tool(token, "baton_get_project", { projectId: "nope" })).result?.isError).toBe(true);

    const lw = await tool<{ items: { kind: string; id: string; askedBy: string }[] }>(token, "baton_list_waiting");
    expect(lw.result!.structuredContent.items.map((x) => x.kind).sort()).toEqual(["approval", "question", "review"]);
    expect(lw.result!.structuredContent.items.find((x) => x.kind === "approval")).toMatchObject({ id: approval.id, askedBy: "リサーチ" });
    const onlyReview = await tool<{ items: { kind: string }[] }>(token, "baton_list_waiting", { kind: "review" });
    expect(onlyReview.result!.structuredContent.items.map((x) => x.kind)).toEqual(["review"]);

    const gi = await tool<Record<string, unknown>>(token, "baton_get_instruction", { instructionId: review });
    expect(gi.result!.structuredContent).toMatchObject({ id: review, status: "review", report: "10 本の案", project: { id: p.project.id, name: "台本" } });

    const rt = await tool<{ items: { seq: number; author: string }[] }>(token, "baton_read_coo_thread", { limit: 2 });
    const items = rt.result!.structuredContent.items;
    expect(items).toHaveLength(2);
    expect(items[0]!.seq).toBeGreaterThan(items[1]!.seq);
    const older = await tool<{ items: { seq: number }[] }>(token, "baton_read_coo_thread", { beforeSeq: items[1]!.seq, limit: 30 });
    expect(older.result!.structuredContent.items.every((x) => x.seq < items[1]!.seq)).toBe(true);
    expect((await tool(token, "baton_read_coo_thread", { limit: 31 })).error?.code).toBe(-32602);
  });

  it("send_to_coo: 秘書の発言（secretary・通知しない）と受信箱の secretary_message。requestId で冪等", async () => {
    const s = await login();
    await clearWork();
    const { token, item } = await issue(s);
    const unreadOf = async () => ((await (await browser(s, "/api/threads")).json()) as { items: { id: string; unread: number }[] }).items.find((t) => t.id === "thread-coo")!.unread;
    const unreadBefore = await unreadOf();
    const res = await tool<{ messageId: string; seq: number }>(token, "baton_send_to_coo", { message: "新しいプロジェクトを始めて", requestId: "req-1" });
    const { messageId, seq } = res.result!.structuredContent;
    const row = await env.DB.prepare("SELECT author_kind, kind, notify, bot_token_id, client_id, seq FROM thread_messages WHERE id = ?").bind(messageId).first();
    expect(row).toEqual({ author_kind: "secretary", kind: "chat", notify: 0, bot_token_id: item.id, client_id: `bot:${item.id}:req-1`, seq });
    const inbox = await env.DB.prepare("SELECT kind, wakes, json_extract(payload, '$.body') AS body FROM thread_inbox WHERE message_id = ?").bind(messageId).first();
    expect(inbox).toEqual({ kind: "secretary_message", wakes: 1, body: "新しいプロジェクトを始めて" });
    expect((await env.DB.prepare("SELECT status FROM threads WHERE id = 'thread-coo'").first())?.status).toBe("queued");
    const again = await tool<{ messageId: string }>(token, "baton_send_to_coo", { message: "新しいプロジェクトを始めて", requestId: "req-1" });
    expect(again.result!.structuredContent.messageId).toBe(messageId);
    // 画面の一覧では「秘書」
    const list = (await (await browser(s, "/api/threads/thread-coo/messages")).json()) as { items: { id: string; authorKind: string; authorName: string }[] };
    expect(list.items.find((m) => m.id === messageId)).toMatchObject({ authorKind: "secretary", authorName: "秘書" });
    // 未読に数えない
    expect(await unreadOf()).toBe(unreadBefore);
    expect((await tool(token, "baton_send_to_coo", { message: "", requestId: "r" })).error?.code).toBe(-32602);
  });

  it("propose_answer: 回答案は判断に付くが決定はされない", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const { token } = await issue(s);
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id });
    const d = (await (await runner(r, "/api/runner/approvals", { body: { id: crypto.randomUUID(), instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: {}, toolUseId: null, question: "q" } })).json()) as Decision;
    const res = await tool<{ ok: boolean }>(token, "baton_propose_answer", { targetId: d.id, proposal: "依存の追加なので許可がよさそう", verdict: "allow" });
    expect(res.result!.structuredContent.ok).toBe(true);
    const row = await env.DB.prepare("SELECT status, verdict, suggestion, suggestion_verdict FROM decisions WHERE id = ?").bind(d.id).first();
    expect(row).toEqual({ status: "open", verdict: null, suggestion: "依存の追加なので許可がよさそう", suggestion_verdict: "allow" });
    const detail = (await (await browser(s, `/api/instructions/${a.id}`)).json()) as { openDecisions: Decision[] };
    expect(detail.openDecisions[0]).toMatchObject({ suggestion: "依存の追加なので許可がよさそう", suggestionVerdict: "allow" });
    expect((await tool(token, "baton_propose_answer", { targetId: crypto.randomUUID(), proposal: "x" })).result?.isError).toBe(true);
    // CEO が決めるまで何も起きない。決めたあとは案を出せない
    await browser(s, `/api/decisions/${d.id}/answer`, { body: { verdict: "deny" } });
    expect((await tool(token, "baton_propose_answer", { targetId: d.id, proposal: "x" })).result?.isError).toBe(true);
  });
});

describe("W44 レート制限・監査・トークン", () => {
  it("トークンは 1 回だけ返り、D1 にはハッシュだけ。一覧・失効", async () => {
    const s = await login();
    const { token, item } = await issue(s, ["read", "read"]);
    expect(token).toMatch(/^btn_bot_[A-Za-z0-9_-]{43}$/);
    expect(item.scopes).toEqual(["read"]);
    const row = await env.DB.prepare("SELECT token_hash FROM bot_tokens WHERE id = ?").bind(item.id).first<{ token_hash: string }>();
    expect(row!.token_hash).not.toContain(token);
    const list = (await (await browser(s, "/api/bot-tokens")).json()) as { items: BotTokenView[] };
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.items.find((x) => x.id === item.id)).toMatchObject({ name: "Grok 秘書", revokedAt: null });
    await browser(s, `/api/bot-tokens/${item.id}`, { method: "DELETE" });
    const after = (await (await browser(s, "/api/bot-tokens")).json()) as { items: BotTokenView[] };
    expect(after.items.find((x) => x.id === item.id)?.revokedAt).not.toBeNull();
    expect((await browser(s, "/api/bot-tokens", { body: { name: "", scopes: ["read"] } })).status).toBe(400);
    expect((await browser(s, "/api/bot-tokens", { body: { name: "x", scopes: ["admin"] } })).status).toBe(400);
  });

  it("すべての呼び出しを記録（道具・対象・引数の要約・結果）。設定から一覧で見られる", async () => {
    const s = await login();
    const { token, item } = await issue(s, ["read"]);
    await tool(token, "baton_overview");
    await tool(token, "baton_send_to_coo", { message: "x", requestId: "1" });
    await tool(token, "baton_get_project", {});
    const audit = (await (await browser(s, `/api/bot-tokens/${item.id}/audit`)).json()) as { items: BotAuditItem[]; nextCursor: string | null };
    expect(audit.items.map((a) => [a.action, a.outcome, a.via])).toEqual([
      ["baton_get_project", "invalid", "mcp"],
      ["baton_send_to_coo", "denied", "mcp"],
      ["baton_overview", "ok", "mcp"],
    ]);
    expect(audit.items[1]!.summary).toContain("requestId");
    expect(audit.nextCursor).toBeNull();
    const tokens = (await (await browser(s, "/api/bot-tokens")).json()) as { items: BotTokenView[] };
    expect(tokens.items.find((x) => x.id === item.id)?.lastUsedAt).not.toBeNull();
    expect((await browser(s, `/api/bot-tokens/${crypto.randomUUID()}/audit`)).status).toBe(404);
  });

  it("60 回／分を超えると -32029（retryAfter）、HTTP は 429。send_to_coo は 10 秒に 1 回", async () => {
    const s = await login();
    await clearWork();
    const { token } = await issue(s);
    await tool(token, "baton_send_to_coo", { message: "一通目", requestId: "a" });
    const tooSoon = await tool(token, "baton_send_to_coo", { message: "二通目", requestId: "b" });
    expect(tooSoon.error?.code).toBe(-32029);
    expect(tooSoon.error?.data?.retryAfter).toBeGreaterThan(0);
    // 同じ requestId の送り直しは制限に当たらない
    expect((await tool(token, "baton_send_to_coo", { message: "一通目", requestId: "a" })).error).toBeUndefined();
    const { token: t2 } = await issue(s, ["read"]);
    for (let n = 0; n < 60; n++) await tool(t2, "baton_list_waiting", { kind: "review" });
    const limited = await tool(t2, "baton_overview");
    expect(limited.error).toMatchObject({ code: -32029 });
    const h = await http(t2, "/api/bot/v1/overview");
    expect(h.status).toBe(429);
    expect(Number(h.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("W44b 並行した呼び出しでも枠を超えない（D-119）", () => {
  it("send_to_coo を同時に 6 本: 届くのは 1 本だけ。同じ requestId の同時の送り直しは枠を再消費しない", async () => {
    const s = await login();
    await clearWork();
    const { token, item } = await issue(s);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => tool(token, "baton_send_to_coo", { message: `同時 ${i}`, requestId: `p${i}` })));
    const ok = results.filter((r) => r.error === undefined && !r.result?.isError);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === -32029)).toHaveLength(5);
    const sent = await env.DB.prepare("SELECT count(*) AS n FROM thread_messages WHERE client_id LIKE ?").bind(`bot:${item.id}:%`).first<{ n: number }>();
    expect(sent!.n).toBe(1);
    // 届いた requestId の送り直しを同時に 3 本: どれも制限に当たらず、行も増えない
    const okIndex = results.findIndex((r) => r.error === undefined);
    const again = await Promise.all(Array.from({ length: 3 }, () => tool(token, "baton_send_to_coo", { message: `同時 ${okIndex}`, requestId: `p${okIndex}` })));
    for (const r of again) expect(r.error).toBeUndefined();
    const slots = await env.DB.prepare("SELECT count(*) AS n FROM bot_rate_slots WHERE token_id = ? AND action = 'baton_send_to_coo'").bind(item.id).first<{ n: number }>();
    expect(slots!.n).toBe(1);
  });

  it("日次の上限: 残り 2 件のところへ同時に 5 本出すと、通るのは 2 本だけ（予約後に失敗したものも数える）", async () => {
    const s = await login();
    const r = await registerRunner();
    await clearWork();
    const { token, item } = await issue(s);
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id });
    const d = (await (await runner(r, "/api/runner/approvals", { body: { id: crypto.randomUUID(), instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: {}, toolUseId: null, question: "q" } })).json()) as Decision;
    const now = Date.now();
    const fill = Array.from({ length: 48 }, (_, i) =>
      env.DB.prepare("INSERT INTO bot_rate_slots (token_id, action, request_id, created_at) VALUES (?, 'baton_propose_answer', ?, ?)").bind(item.id, `old${i}`, now - 60_000 - i),
    );
    await env.DB.batch(fill);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => tool<{ ok: boolean }>(token, "baton_propose_answer", { targetId: d.id, proposal: `案 ${i}` })));
    expect(results.filter((x) => x.result?.structuredContent?.ok === true)).toHaveLength(2);
    expect(results.filter((x) => x.error?.code === -32029)).toHaveLength(3);
    const slots = await env.DB.prepare("SELECT count(*) AS n FROM bot_rate_slots WHERE token_id = ? AND action = 'baton_propose_answer'").bind(item.id).first<{ n: number }>();
    expect(slots!.n).toBe(50);
    // 1 日前より古い枠は数えない
    await env.DB.prepare("UPDATE bot_rate_slots SET created_at = ? WHERE token_id = ? AND request_id LIKE 'old%'").bind(now - 2 * 24 * 60 * 60 * 1000, item.id).run();
    expect((await tool<{ ok: boolean }>(token, "baton_propose_answer", { targetId: d.id, proposal: "翌日" })).result?.structuredContent?.ok).toBe(true);
  });
});

describe("W45 HTTP API と OpenAPI", () => {
  it("HTTP 層は MCP と同じ結果を返す。OpenAPI が取れる", async () => {
    const s = await login();
    const r = await registerRunner();
    const { token } = await issue(s);
    const p = await createProject(r, undefined, "HTTP の確認");
    const viaMcp = await tool(token, "baton_get_project", { projectId: p.project.id });
    const viaHttp = await (await http(token, `/api/bot/v1/projects/${p.project.id}`)).json();
    expect(viaHttp).toEqual(viaMcp.result!.structuredContent);
    const mcpThread = await tool(token, "baton_read_coo_thread", { limit: 3 });
    expect(await (await http(token, "/api/bot/v1/coo-thread?limit=3")).json()).toEqual(mcpThread.result!.structuredContent);
    expect(await (await http(token, "/api/bot/v1/projects?status=all")).json()).toEqual((await tool(token, "baton_list_projects", { status: "all" })).result!.structuredContent);
    expect((await http(token, "/api/bot/v1/projects/nope")).status).toBe(404);
    expect((await http(token, "/api/bot/v1/coo-thread?limit=99")).status).toBe(400);
    const sent = await http(token, "/api/bot/v1/coo-thread/messages", { body: { message: "HTTP から", requestId: "http-1" } });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ messageId: expect.any(String), seq: expect.any(Number) });
    const audit = await env.DB.prepare("SELECT via FROM bot_audit_log WHERE action = 'baton_send_to_coo' ORDER BY created_at DESC LIMIT 1").first();
    expect(audit).toEqual({ via: "http" });
    const doc = (await (await call("/api/bot/v1/openapi.json")).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/api/bot/v1/overview", "/api/bot/v1/coo-thread/messages", "/api/bot/v1/projects/{projectId}"]));
  });
});
