// W26 マイグレーション 0002: v1 の形のデータ（指示・プロジェクト・agent_events・ai_usage）が v2 の形に移る（DESIGN-v2 8.2・16.1・D-63）
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("W26 マイグレーション 0002", () => {
  it("COO スレッド・リーダーのスレッド・過去の発言・legacy セッション・既読ができ、ai_usage は消える", async () => {
    const db = env.MIGRATION_DB;
    const [m1, m2] = env.TEST_MIGRATIONS;
    expect(m1!.name).toMatch(/^0001/);
    expect(m2!.name).toMatch(/^0002/);
    await applyD1Migrations(db, [m1!]);
    await db.batch([
      db.prepare("INSERT INTO users (id, email, name, created_at, last_login_at) VALUES ('u1', 'ceo@example.com', 'CEO', 1, 1)"),
      db.prepare("INSERT INTO projects (id, slug, name, summary, status, created_at, updated_at) VALUES ('p1', 'coffee-recipe', 'コーヒー', '', 'active', 10, 20)"),
      db.prepare("INSERT INTO agents (id, project_id, role, name, specialty, active, created_at) VALUES ('a1', 'p1', 'leader', 'リーダー', '', 1, 10)"),
      db.prepare(
        `INSERT INTO instructions (id, client_id, created_by, body, title, status, status_changed_at, project_id, result_summary, created_at, updated_at, completed_at)
         VALUES ('i1', 'c1', 'u1', '最初の依頼', 'T1', 'done', 30, 'p1', '終わりました', 30, 40, 40),
                ('i2', 'c2', 'u1', '二つ目', NULL, 'archived', 50, NULL, NULL, 50, 60, NULL)`,
      ),
      db.prepare("INSERT INTO agent_events (id, instruction_id, seq, kind, content, created_at) VALUES ('e1', 'i1', 0, 'note', '\"メモ\"', 31), ('e2', 'i1', 1, 'summary', '{\"a\":1}', 32)"),
      db.prepare("INSERT INTO ai_usage (id, day, model, role, tokens_in, tokens_out, created_at) VALUES ('x', '2026-10-19', 'm', 'coo', 1, 1, 1)"),
    ]);
    await applyD1Migrations(db, [m2!]);

    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    expect(tables).not.toContain("ai_usage");
    const threads = (await db.prepare("SELECT id, kind, project_id, agent_id, last_seq FROM threads ORDER BY kind").all()).results;
    expect(threads).toEqual([
      { id: "thread-coo", kind: "coo", project_id: null, agent_id: "agent-coo", last_seq: 3 },
      { id: "thread-p1", kind: "leader", project_id: "p1", agent_id: "a1", last_seq: 0 },
    ]);
    const msgs = (await db.prepare("SELECT seq, author_kind, kind, body, instruction_id FROM thread_messages ORDER BY seq").all()).results;
    expect(msgs).toEqual([
      { seq: 1, author_kind: "ceo", kind: "chat", body: "最初の依頼", instruction_id: "i1" },
      { seq: 2, author_kind: "coo", kind: "report", body: "終わりました", instruction_id: "i1" },
      { seq: 3, author_kind: "ceo", kind: "chat", body: "二つ目", instruction_id: "i2" },
    ]);
    const inst = (await db.prepare("SELECT id, origin_thread_id, origin_message_id, revision, cost_usd_est FROM instructions ORDER BY id").all()).results;
    expect(inst[0]).toEqual({ id: "i1", origin_thread_id: "thread-coo", origin_message_id: "v1-ceo-i1", revision: 1, cost_usd_est: 0 });
    const legacy = await db.prepare("SELECT id, role, last_seq FROM agent_sessions").all();
    expect(legacy.results).toEqual([{ id: "legacy-i1", role: "legacy", last_seq: 1 }]);
    const items = (await db.prepare("SELECT seq, kind, summary FROM transcript_items ORDER BY seq").all()).results;
    expect(items).toEqual([{ seq: 0, kind: "legacy", summary: "note" }, { seq: 1, kind: "legacy", summary: "summary" }]);
    expect(await db.prepare("SELECT user_id, last_read_seq FROM thread_reads").first()).toEqual({ user_id: "u1", last_read_seq: 3 });
    const project = await db.prepare("SELECT workspace_kind, repo_path, goal FROM projects").first();
    expect(project).toEqual({ workspace_kind: "baton", repo_path: null, goal: "" });
    // 外部キーの整合
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
