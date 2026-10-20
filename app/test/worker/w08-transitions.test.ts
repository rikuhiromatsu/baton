// W8 遷移: 3.4 の全 CEO 操作、expectedStatus 違いで 409、undo
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CEO_ACTIONS, INSTRUCTION_STATUSES, nextStatus, type InstructionStatus, type TransitionOutput } from "@baton/shared";
import { browser, insertInstruction, login, statusOf, type TestSession } from "./helpers.ts";

async function transition(s: TestSession, id: string, action: string, expectedStatus: string, comment?: string) {
  return browser(s, `/api/instructions/${id}/transition`, { body: { action, expectedStatus, ...(comment !== undefined ? { comment } : {}) } });
}

async function ok(s: TestSession, id: string, action: string, expected: string, comment?: string): Promise<TransitionOutput> {
  const res = await transition(s, id, action, expected, comment);
  if (res.status !== 200) throw new Error(`${action} from ${expected}: ${res.status} ${await res.text()}`);
  return (await res.json()) as TransitionOutput;
}

describe("W8 CEO の遷移", () => {
  const cases: { from: InstructionStatus; action: string; to: InstructionStatus }[] = [
    { from: "review", action: "approve", to: "done" },
    { from: "review", action: "send_back", to: "queued" },
    { from: "queued", action: "cancel", to: "canceled" },
    { from: "running", action: "cancel", to: "canceled" },
    { from: "needs_decision", action: "cancel", to: "canceled" },
    { from: "failed", action: "retry", to: "queued" },
    { from: "canceled", action: "retry", to: "queued" },
    { from: "failed", action: "archive", to: "archived" },
    { from: "canceled", action: "archive", to: "archived" },
    { from: "done", action: "archive", to: "archived" },
  ];
  for (const c of cases) {
    it(`${c.from} --${c.action}--> ${c.to}`, async () => {
      const s = await login();
      const id = await insertInstruction(s.userId, { status: c.from });
      const out = await ok(s, id, c.action, c.from, c.action === "send_back" ? "やり直して" : undefined);
      expect(out.instruction.status).toBe(c.to);
      expect(out.transitionId).toBeTruthy();
      expect(await statusOf(id)).toBe(c.to);
      const t = await env.DB.prepare("SELECT * FROM status_transitions WHERE id = ?").bind(out.transitionId).first<Record<string, unknown>>();
      expect(t).toMatchObject({ from_status: c.from, to_status: c.to, action: c.action, actor: "ceo", undone: 0 });
    });
  }

  for (const original of ["done", "canceled", "failed"] as const) {
    it(`archived --restore--> ${original}（アーカイブ前の状態）`, async () => {
      const s = await login();
      const id = await insertInstruction(s.userId, { status: original });
      await ok(s, id, "archive", original);
      const out = await ok(s, id, "restore", "archived");
      expect(out.instruction.status).toBe(original);
    });
  }

  it("許されない組み合わせはすべて 409（総当たり）", async () => {
    const s = await login();
    for (const from of INSTRUCTION_STATUSES) {
      for (const action of CEO_ACTIONS) {
        if (action === "restore" || nextStatus(from, action) !== null) continue;
        const id = await insertInstruction(s.userId, { status: from });
        const res = await transition(s, id, action, from, "c");
        expect(res.status, `${from} ${action}`).toBe(409);
        expect(await statusOf(id)).toBe(from);
      }
    }
    // 記録の無い archived は restore できない
    const id = await insertInstruction(s.userId, { status: "archived" });
    expect((await transition(s, id, "restore", "archived")).status).toBe(409);
  });

  it("expectedStatus が今の状態と違えば 409", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "running" });
    const res = await transition(s, id, "approve", "review");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict", details: { status: "running" } } });
    expect(await statusOf(id)).toBe("running");
  });

  it("send_back はコメントを feedback に保存し、コメント無しは 400", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "review" });
    expect((await transition(s, id, "send_back", "review")).status).toBe(400);
    await ok(s, id, "send_back", "review", "表を足して");
    const row = await env.DB.prepare("SELECT feedback, status FROM instructions WHERE id = ?").bind(id).first<{ feedback: string; status: string }>();
    expect(row).toEqual({ feedback: "表を足して", status: "queued" });
  });

  it("send_back は CEO の発言の上限に当たるなら、遷移を確定せずに 429（やり直せる）", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "review" });
    const now = Date.now();
    const fill = Array.from({ length: 30 }, (_, i) =>
      env.DB.prepare("INSERT INTO thread_messages (id, thread_id, seq, author_kind, kind, body, status, created_at, updated_at) VALUES (?, 'thread-coo', ?, 'ceo', 'chat', 'x', 'complete', ?, ?)").bind(crypto.randomUUID(), 900_000 + i, now, now),
    );
    await env.DB.batch(fill);
    expect((await transition(s, id, "send_back", "review", "表を足して")).status).toBe(429);
    expect(await statusOf(id)).toBe("review");
    await env.DB.prepare("DELETE FROM thread_messages WHERE seq >= 900000").run();
  });

  it("approve で completedAt が入る。running の cancel で lease が外れ、open の判断は閉じる", async () => {
    const s = await login();
    const a = await insertInstruction(s.userId, { status: "review" });
    expect((await ok(s, a, "approve", "review")).instruction.completedAt).not.toBeNull();
    const b = await insertInstruction(s.userId, { status: "needs_decision" });
    await env.DB.prepare("INSERT INTO decisions (id, instruction_id, question, status, created_at) VALUES (?, ?, 'q', 'open', 0)").bind(crypto.randomUUID(), b).run();
    const out = await ok(s, b, "cancel", "needs_decision");
    expect(out.instruction.openDecisionId).toBeNull();
  });
});

describe("W8 undo", () => {
  it("15 秒以内なら元に戻る（approve → review、completedAt も消える）", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "review" });
    const t = await ok(s, id, "approve", "review");
    const res = await browser(s, `/api/transitions/${t.transitionId}/undo`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instruction: { status: string; completedAt: number | null } };
    expect(body.instruction).toMatchObject({ status: "review", completedAt: null });
    const undone = await env.DB.prepare("SELECT undone FROM status_transitions WHERE id = ?").bind(t.transitionId).first<{ undone: number }>();
    expect(undone?.undone).toBe(1);
  });

  it("cancel の undo は queued に戻る（元が running でも）", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "running" });
    const t = await ok(s, id, "cancel", "running");
    const res = await browser(s, `/api/transitions/${t.transitionId}/undo`, { method: "POST" });
    expect(((await res.json()) as { instruction: { status: string } }).instruction.status).toBe("queued");
    // queued は取られないので、COO のスレッドを起こす受信箱の項目が入る（Codex 指摘）
    const inbox = await env.DB.prepare("SELECT wakes, status FROM thread_inbox WHERE thread_id = 'thread-coo' AND instruction_id = ? AND kind = 'instruction_event' AND wakes = 1").bind(id).first();
    expect(inbox).toEqual({ wakes: 1, status: "pending" });
  });

  it("archive・retry・restore も戻せる", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "failed" });
    const a = await ok(s, id, "archive", "failed");
    expect((await browser(s, `/api/transitions/${a.transitionId}/undo`, { method: "POST" })).status).toBe(200);
    expect(await statusOf(id)).toBe("failed");
    const r = await ok(s, id, "retry", "failed");
    expect((await browser(s, `/api/transitions/${r.transitionId}/undo`, { method: "POST" })).status).toBe(200);
    expect(await statusOf(id)).toBe("failed");
    await ok(s, id, "archive", "failed");
    const rs = await ok(s, id, "restore", "archived");
    expect((await browser(s, `/api/transitions/${rs.transitionId}/undo`, { method: "POST" })).status).toBe(200);
    expect(await statusOf(id)).toBe("archived");
  });

  it("期限切れ（15 秒超）は 409", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "review" });
    const t = await ok(s, id, "approve", "review");
    await env.DB.prepare("UPDATE status_transitions SET created_at = ? WHERE id = ?").bind(Date.now() - 15_001, t.transitionId).run();
    const res = await browser(s, `/api/transitions/${t.transitionId}/undo`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe("done");
  });

  it("二重 undo は 409", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "done" });
    const t = await ok(s, id, "archive", "done");
    expect((await browser(s, `/api/transitions/${t.transitionId}/undo`, { method: "POST" })).status).toBe(200);
    expect((await browser(s, `/api/transitions/${t.transitionId}/undo`, { method: "POST" })).status).toBe(409);
    expect(await statusOf(id)).toBe("done");
  });

  it("間に別の遷移があれば 409", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "done" });
    const first = await ok(s, id, "archive", "done");
    await ok(s, id, "restore", "archived");
    const res = await browser(s, `/api/transitions/${first.transitionId}/undo`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe("done");
  });

  it("send_back は取り消せない。存在しない遷移は 404", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "review" });
    const t = await ok(s, id, "send_back", "review", "やり直し");
    expect((await browser(s, `/api/transitions/${t.transitionId}/undo`, { method: "POST" })).status).toBe(409);
    expect((await browser(s, `/api/transitions/${crypto.randomUUID()}/undo`, { method: "POST" })).status).toBe(404);
  });
});
