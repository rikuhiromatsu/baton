// W1 マイグレーション（0003 まで）が適用でき、COO と COO スレッドの初期データがある
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("W1 マイグレーション", () => {
  it("v1 と v2 の全テーブルがあり、ai_usage は無い。COO が 1 体、COO スレッドが 1 本", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of [
      "users", "sessions", "oauth_flows", "projects", "agents", "runners", "instructions", "status_transitions", "tasks", "decisions", "agent_events", "artifacts",
      "runner_repos", "workspaces", "threads", "thread_messages", "thread_reads", "thread_inbox", "project_proposals", "agent_sessions", "transcript_items",
      "session_inputs", "push_subscriptions", "bot_tokens", "bot_audit_log", "bot_rate_slots",
    ]) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain("ai_usage");
    const coo = await env.DB.prepare("SELECT * FROM agents WHERE role = 'coo'").all<{ id: string; project_id: string | null; name: string }>();
    expect(coo.results).toHaveLength(1);
    expect(coo.results[0]).toMatchObject({ id: "agent-coo", project_id: null, name: "COO" });
    const thread = await env.DB.prepare("SELECT * FROM threads WHERE kind = 'coo'").all<{ id: string; agent_id: string }>();
    expect(thread.results).toEqual([expect.objectContaining({ id: "thread-coo", agent_id: "agent-coo" })]);
  });
});
