// W7 指示の作成、一覧・詳細（7.3 の並び、7 日の打ち切り、taskCounts）
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstructionDetailSchema, ListInstructionsOutput, type InstructionSummary } from "@baton/shared";
import { browser, createInstruction, insertInstruction, login } from "./helpers.ts";

describe("W7 指示の作成", () => {
  it("201 で queued の InstructionSummary を返す", async () => {
    const s = await login();
    const clientId = crypto.randomUUID();
    const res = await browser(s, "/api/instructions", { body: { clientId, body: "  市場を調べて  " } });
    expect(res.status).toBe(201);
    const inst = (await res.json()) as InstructionSummary;
    expect(inst).toMatchObject({ clientId, body: "市場を調べて", status: "queued", title: null, projectId: null, openDecisionId: null });
    expect(inst.taskCounts).toEqual({ total: 0, done: 0, running: 0, failed: 0 });
  });

  it("同じ clientId の再送は 200 で既存を返し、1 件のまま", async () => {
    const s = await login();
    const clientId = crypto.randomUUID();
    const a = await browser(s, "/api/instructions", { body: { clientId, body: "一回だけ" } });
    const b = await browser(s, "/api/instructions", { body: { clientId, body: "一回だけ" } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(((await b.json()) as InstructionSummary).id).toBe(((await a.json()) as InstructionSummary).id);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM instructions WHERE client_id = ?").bind(clientId).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("本文 8001 文字は 400、8000 文字は通る、空白だけは 400", async () => {
    const s = await login();
    const over = await browser(s, "/api/instructions", { body: { clientId: crypto.randomUUID(), body: "あ".repeat(8001) } });
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ error: { code: "invalid" } });
    expect((await browser(s, "/api/instructions", { body: { clientId: crypto.randomUUID(), body: "あ".repeat(8000) } })).status).toBe(201);
    expect((await browser(s, "/api/instructions", { body: { clientId: crypto.randomUUID(), body: "   " } })).status).toBe(400);
    expect((await browser(s, "/api/instructions", { body: { clientId: "not-a-uuid", body: "x" } })).status).toBe(400);
  });

  it("1 分 30 件を超えると 429 rate_limited", async () => {
    const s = await login("second@example.com");
    const now = Date.now();
    for (let n = 0; n < 30; n++) await insertInstruction(s.userId, { createdAt: now - 1000 });
    const res = await browser(s, "/api/instructions", { body: { clientId: crypto.randomUUID(), body: "31 件目" } });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("一覧と詳細", () => {
  it("active は 7.3 の順で、archived と 7 日より古い done/canceled を出さない", async () => {
    const s = await login();
    await env.DB.prepare("DELETE FROM instructions").run();
    const now = Date.now();
    const day = 24 * 3600_000;
    const ids: Record<string, string> = {};
    const mk = async (key: string, status: string, ago: number) => {
      ids[key] = await insertInstruction(s.userId, { status, statusChangedAt: now - ago, createdAt: now - ago - 1000 });
    };
    await mk("done_new", "done", 1000);
    await mk("done_old", "done", 8 * day);
    await mk("canceled_old", "canceled", 8 * day);
    await mk("canceled_new", "canceled", 2 * day);
    await mk("failed_old", "failed", 30 * day);
    await mk("queued_a", "queued", 5000);
    await mk("queued_b", "queued", 1000);
    await mk("running", "running", 3000);
    await mk("review", "review", 9000);
    await mk("decision", "needs_decision", 9000);
    await mk("archived", "archived", 1000);

    const res = await browser(s, "/api/instructions?view=active");
    const body = ListInstructionsOutput.parse(await res.json());
    const order = body.items.map((i) => Object.entries(ids).find(([, id]) => id === i.id)?.[0]);
    expect(order).toEqual(["decision", "review", "running", "queued_b", "queued_a", "failed_old", "canceled_new", "done_new"]);
    expect(body.nextCursor).toBeNull();

    const archived = ListInstructionsOutput.parse(await (await browser(s, "/api/instructions?view=archived")).json());
    expect(archived.items.map((i) => i.id)).toEqual([ids.archived]);
  });

  it("50 件ずつのページ", async () => {
    const s = await login();
    await env.DB.prepare("DELETE FROM instructions").run();
    for (let n = 0; n < 55; n++) await insertInstruction(s.userId, { createdAt: Date.now() - 3_600_000 - n });
    const first = ListInstructionsOutput.parse(await (await browser(s, "/api/instructions")).json());
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = ListInstructionsOutput.parse(await (await browser(s, `/api/instructions?cursor=${first.nextCursor}`)).json());
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(55);
  });

  it("taskCounts は work だけ、projectName は結合、openDecisionId は open の判断", async () => {
    const s = await login();
    const id = await insertInstruction(s.userId, { status: "needs_decision" });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id, slug, name, summary, created_at, updated_at) VALUES ('p-tc', 'tc', '集計', '', ?, ?)").bind(now, now),
      env.DB.prepare("UPDATE instructions SET project_id = 'p-tc' WHERE id = ?").bind(id),
      ...[
        ["plan", "done"],
        ["work", "done"],
        ["work", "running"],
        ["work", "failed"],
        ["work", "pending"],
        ["review", "pending"],
      ].map(([kind, status], n) =>
        env.DB.prepare("INSERT INTO tasks (id, instruction_id, kind, title, status, seq, created_at, updated_at) VALUES (?, ?, ?, 't', ?, ?, ?, ?)").bind(
          crypto.randomUUID(),
          id,
          kind,
          status,
          n,
          now,
          now,
        ),
      ),
      env.DB.prepare("INSERT INTO decisions (id, instruction_id, question, status, created_at) VALUES ('d-old', ?, 'q', 'answered', ?)").bind(id, now - 10),
      env.DB.prepare("INSERT INTO decisions (id, instruction_id, question, status, created_at) VALUES ('d-open', ?, 'q', 'open', ?)").bind(id, now),
    ]);
    const detailRes = await browser(s, `/api/instructions/${id}`);
    expect(detailRes.status).toBe(200);
    const detail = InstructionDetailSchema.parse(await detailRes.json());
    expect(detail.instruction.taskCounts).toEqual({ total: 4, done: 1, running: 1, failed: 1 });
    expect(detail.instruction.projectName).toBe("集計");
    expect(detail.instruction.openDecisionId).toBe("d-open");
    expect(detail.project?.slug).toBe("tc");
    expect(detail.tasks).toHaveLength(6);
    expect(detail.tasks[0]?.kind).toBe("plan");
    expect(detail.decisions.map((d) => d.id)).toEqual(["d-old", "d-open"]);
    expect(detail.lastEventSeq).toBe(-1);
  });

  it("存在しない指示は 404", async () => {
    const s = await login();
    const res = await browser(s, `/api/instructions/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("作成した指示が一覧に出る", async () => {
    const s = await login();
    const inst = await createInstruction(s, "一覧に出る");
    const list = ListInstructionsOutput.parse(await (await browser(s, "/api/instructions")).json());
    expect(list.items.some((i) => i.id === inst.id)).toBe(true);
  });
});
