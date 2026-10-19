// W1 マイグレーションが適用でき、COO の初期データがある
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("W1 マイグレーション", () => {
  it("全テーブルがあり、COO が 1 体だけいる", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["users", "sessions", "oauth_flows", "projects", "agents", "runners", "instructions", "status_transitions", "tasks", "decisions", "agent_events", "artifacts", "ai_usage"]) {
      expect(names).toContain(t);
    }
    const coo = await env.DB.prepare("SELECT * FROM agents WHERE role = 'coo'").all<{ id: string; project_id: string | null; name: string }>();
    expect(coo.results).toHaveLength(1);
    expect(coo.results[0]).toMatchObject({ id: "agent-coo", project_id: null, name: "COO" });
  });
});
