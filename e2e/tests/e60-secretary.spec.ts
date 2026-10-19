// E60 秘書 bot（DESIGN-v2 11 章・D-90・D-91、シナリオ B4）:
// 設定でトークンを発行（1 回だけ表示）→ そのトークンで /mcp に initialize・tools/list・tools/call →
// baton_send_to_coo で「新しいプロジェクトを始めて」→ COO スレッドに `秘書から` の吹き出しと COO の返事。COO は立てずに CEO に確かめる
// （ランナーも delegate・propose_project を行わない）→ baton_propose_answer で承認カードに `秘書の案`（決定はしない）→ CEO が `許可` →
// できない操作（スコープ外・無い道具・Cookie だけ）は拒否 → 失効したら 401
import { API_PATHS, BOT_TOOL_NAMES, BOT_TOKEN_PREFIX, COO_THREAD_ID, MCP_ERRORS, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { MARK, PROJECTS, RUNNER_TIMEOUT } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { mcp, mcpCallTool, mcpInitialize, mcpRaw, mcpToolsList } from "../helpers/mcp.ts";
import { byTestId, expectMessageOnScreen, expectStable, onlyOn, uniqueMarker } from "../helpers/ui.ts";

const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

test("E60 秘書 bot は MCP で様子を読み COO に伝えられるが、決定や立ち上げはできない", async ({ page, api }, testInfo) => {
  onlyOn(testInfo, [PROJECTS.desktop]);
  test.setTimeout(300_000);
  const marker = uniqueMarker("E60", testInfo);

  // ───── 設定でトークンを発行（本体は 1 回だけ表示） ─────
  await page.goto("/settings");
  await expect(byTestId(page, TESTIDS.settings)).toBeVisible();
  await byTestId(page, TESTIDS.botTokenCreate).click();
  const value = byTestId(page, TESTIDS.botTokenValue);
  if (!(await value.isVisible().catch(() => false))) {
    // 名前とスコープを選んで `発行`（13.10）
    const name = page.getByLabel(UI_TEXT_V2.settings.name);
    if (await name.isVisible().catch(() => false)) await name.fill(`${marker} 秘書`);
    for (const scope of [UI_TEXT_V2.settings.scopeRead, UI_TEXT_V2.settings.scopeMessage, UI_TEXT_V2.settings.scopePropose]) {
      const box = page.getByRole("checkbox", { name: scope });
      if ((await box.count()) > 0) await box.first().check();
    }
    await page.getByRole("button", { name: UI_TEXT_V2.settings.issue, exact: true }).last().click();
  }
  await expect(value).toBeVisible();
  const token = ((await value.inputValue().catch(() => null)) ?? (await value.textContent()) ?? "").trim();
  expect(token.startsWith(BOT_TOKEN_PREFIX), `トークンの形: ${token.slice(0, 12)}…`).toBe(true);
  await expect(page.getByText(UI_TEXT_V2.settings.shownOnce)).toBeVisible();
  await page.reload();
  await expect(byTestId(page, TESTIDS.botTokenItem).first()).toBeVisible();
  await expect(byTestId(page, TESTIDS.botTokenValue)).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);

  const req = page.request;

  // ───── initialize・tools/list・tools/call ─────
  const init = await mcpInitialize(req, token);
  expect(init.error).toBeUndefined();
  expect(init.result?.serverInfo.name).toBe("baton");
  expect(init.result?.protocolVersion).toBeTruthy();
  const tools = await mcpToolsList(req, token);
  expect(tools.map((t) => t.name).sort()).toEqual([...BOT_TOOL_NAMES].sort());
  for (const t of tools) expect(t.description, `${t.name} の説明文は日本語`).toMatch(JAPANESE);
  const overview = await mcpCallTool(req, token, "baton_overview");
  expect(overview.error).toBeUndefined();
  expect(overview.result?.isError ?? false).toBe(false);
  expect(overview.result?.content[0]?.text ?? "").toMatch(JAPANESE);
  expect(Array.isArray((overview.result?.structuredContent as { projects?: unknown[] })?.projects)).toBe(true);
  // HTTP 層は MCP と同じ結果（12.4）。OpenAPI も取れる
  const http = await req.get(API_PATHS.botOverview, { headers: { Authorization: `Bearer ${token}` } });
  expect(http.status()).toBe(200);
  const httpBody = (await http.json()) as { projects: { id: string }[] };
  expect(httpBody.projects.map((p) => p.id).sort()).toEqual(
    ((overview.result?.structuredContent as { projects: { id: string }[] }).projects ?? []).map((p) => p.id).sort(),
  );
  expect((await req.get(API_PATHS.botOpenApi, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);

  // ───── Cookie だけでは通らない（ログイン済みの page.request でも Authorization が無ければ 401） ─────
  expect((await mcpRaw(req, null, { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} })).status()).toBe(401);

  // ───── B4: 秘書が COO に「新しいプロジェクトを始めて」→ COO は立てずに CEO に確かめる ─────
  await page.goto("/");
  const start = await api.lastSeq(COO_THREAD_ID);
  const beforeInstructions = (await api.list()).length;
  const beforeProjects = (await api.projects()).length;
  const requestId = `${marker}-1`;
  const sent = await mcpCallTool(req, token, "baton_send_to_coo", { message: `${marker} 新しいプロジェクトを始めて`, requestId });
  expect(sent.error).toBeUndefined();
  const sentOut = sent.result?.structuredContent as { messageId: string; seq: number };
  expect(sentOut.messageId).toBeTruthy();
  // 同じ requestId で送り直しても 1 回だけ
  const again = await mcpCallTool(req, token, "baton_send_to_coo", { message: `${marker} 新しいプロジェクトを始めて`, requestId });
  expect((again.result?.structuredContent as { messageId: string }).messageId).toBe(sentOut.messageId);

  const secSeq = await expectMessageOnScreen(page, { author: "secretary", text: marker, afterSeq: start, status: null }, 15_000);
  await expect(page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${secSeq}"]`)).toContainText(UI_TEXT_V2.conversation.fromSecretary);
  const secMsg = (await api.messages(COO_THREAD_ID)).find((m) => m.seq === secSeq)!;
  expect(secMsg.notify, "秘書の発言は通知しない").toBe(false);
  // COO は CEO に確かめる発言をする（偽 claude は「進めてよいか CEO に確かめます」）
  const cooSeq = await expectMessageOnScreen(page, { author: "coo", afterSeq: secSeq }, RUNNER_TIMEOUT);
  await expect(page.locator(`[data-testid="${TESTIDS.message}"][data-seq="${cooSeq}"]`)).toContainText("CEO に確かめます");
  await expectStable(
    async () => ({ instructions: (await api.list()).length, projects: (await api.projects()).length }),
    3_000,
    "秘書の依頼ではプロジェクトも指示もできない",
  );
  expect((await api.list()).length).toBe(beforeInstructions);
  expect((await api.projects()).length).toBe(beforeProjects);
  expect(await api.findMessages(COO_THREAD_ID, { kind: "project_proposal", afterSeq: start, status: null })).toHaveLength(0);

  // ───── 回答案: 承認待ちに `秘書の案` を添える（決定はしない）→ CEO が許可 ─────
  const created = await api.createInstructionViaChat(uniqueMarker("E60a", testInfo), `${MARK.approve} パッケージを足して`);
  const decision = await api.waitForOpenDecision(created.id);
  const proposal = `${marker} 依存の追加は小さいので許可がよさそう`;
  const proposed = await mcpCallTool(req, token, "baton_propose_answer", { targetId: decision.id, proposal, verdict: "allow" });
  expect(proposed.error).toBeUndefined();
  expect(proposed.result?.isError ?? false).toBe(false);
  const withSuggestion = await api.waitForDetail(created.id, (d) => d.openDecisions.some((x) => x.suggestion?.includes(marker)), "判断に秘書の案が付く", 15_000);
  expect(withSuggestion.openDecisions.every((x) => x.status === "open"), "決定はされない").toBe(true);
  await page.goto(`/i/${created.id}${decision.sessionId ? `?s=${decision.sessionId}` : ""}`);
  const suggestion = byTestId(page, TESTIDS.approvalSuggestion).first();
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText(UI_TEXT_V2.conversation.secretarySuggestion);
  await expect(suggestion).toContainText("許可がよさそう");
  await byTestId(page, TESTIDS.approvalAllow).first().click();
  await api.waitForDetail(created.id, (d) => d.decisions.some((x) => x.verdict === "allow" && x.status === "answered"), "CEO が許可", 15_000);

  // ───── できない操作は拒否 ─────
  // 無い道具（承認の決定など）は呼べない
  const forbiddenTool = await mcpCallTool(req, token, "baton_approve", { targetId: decision.id });
  expect(forbiddenTool.error !== undefined || forbiddenTool.result?.isError === true, "無い道具は拒否").toBe(true);
  // スコープ外: 読むだけのトークンは送れない（tools/list に出ず、tools/call で拒否）
  const readOnly = await api.createBotToken(`${marker} 読むだけ`, ["read"]);
  const roTools = (await mcpToolsList(req, readOnly.token)).map((t) => t.name);
  expect(roTools).not.toContain("baton_send_to_coo");
  expect(roTools).not.toContain("baton_propose_answer");
  const roSend = await mcpCallTool(req, readOnly.token, "baton_send_to_coo", { message: "送れないはず", requestId: `${marker}-ro` });
  expect(roSend.error?.code ?? (roSend.result?.isError ? MCP_ERRORS.forbidden : null), "スコープ外は拒否").toBe(MCP_ERRORS.forbidden);
  // 知らないメソッド
  const unknown = await mcp(req, token, "resources/list", {});
  expect(unknown.error?.code).toBe(MCP_ERRORS.methodNotFound);

  // ───── 監査ログに残る ─────
  // 画面で発行したトークン（読むだけのトークンより前に作った、失効していない最新のもの）
  const issued = (await api.botTokens())
    .filter((t) => t.id !== readOnly.item.id && t.revokedAt === null && t.scopes.includes("message"))
    .sort((a, b) => b.createdAt - a.createdAt)[0]!;
  expect(issued, "発行したトークンが一覧にある").toBeTruthy();
  const audit = await req.get(API_PATHS.botTokenAudit(issued.id));
  expect(audit.status()).toBe(200);
  const auditItems = ((await audit.json()) as { items: { action: string }[] }).items.map((i) => i.action);
  expect(auditItems).toEqual(expect.arrayContaining(["baton_overview", "baton_send_to_coo", "baton_propose_answer"]));

  // ───── 設定で失効 → 401 ─────
  await page.goto("/settings");
  page.once("dialog", (d) => void d.accept());
  const item = byTestId(page, TESTIDS.botTokenItem).filter({ hasText: issued.name }).first();
  await byTestId(item, TESTIDS.botTokenRevoke).click();
  await expect.poll(async () => (await api.botTokens()).find((t) => t.id === issued.id)?.revokedAt ?? null, { timeout: 10_000 }).not.toBeNull();
  expect((await mcpRaw(req, token, { jsonrpc: "2.0", id: 100, method: "tools/list", params: {} })).status()).toBe(401);
  await api.revokeBotToken(readOnly.item.id).catch(() => {});
});
