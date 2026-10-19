// R10 サブスク枠（9 章・D-55）: rejected で blockedUntil まで止めて自動で続ける。しきい値（5 時間 80%・週 90%）でメンバーを起動しない。
import { afterEach, describe, expect, it } from "vitest";
import { COO_THREAD_ID, type QuotaObservation } from "@baton/shared";
import { QuotaGate } from "../src/quota.ts";
import { makeEnv, type Env } from "./helpers.ts";

let env: Env;
afterEach(async () => {
  await env?.cleanup();
});

const obs = (o: Partial<QuotaObservation>): QuotaObservation => ({ status: "allowed", rateLimitType: "five_hour", resetsAt: null, utilization: null, fiveHour: null, sevenDay: null, ...o });

describe("R10 枠", () => {
  it("QuotaGate: しきい値でメンバーだけ止める、rejected は resetsAt＋余裕まで全部止め、過ぎたら戻る", () => {
    let now = 1_000_000;
    const q = new QuotaGate(() => now, 1000);
    expect(q.canStartMember()).toBe(true);
    q.observe(obs({ fiveHour: { utilization: 0.81, resetsAt: now + 3_600_000 }, sevenDay: { utilization: 0.1, resetsAt: null } }));
    expect(q.canStartMember()).toBe(false);
    expect(q.canStartThreadTurn()).toBe(true);
    q.observe(obs({ fiveHour: { utilization: 0.5, resetsAt: null }, sevenDay: { utilization: 0.91, resetsAt: null } }));
    expect(q.canStartMember()).toBe(false);
    q.observe(obs({ fiveHour: { utilization: 0.5, resetsAt: null }, sevenDay: { utilization: 0.5, resetsAt: null } }));
    expect(q.canStartMember()).toBe(true);
    q.observe(obs({ status: "rejected", resetsAt: now + 5000 }));
    expect(q.blockedUntil).toBe(now + 6000);
    expect(q.canStartThreadTurn()).toBe(false);
    now += 6000;
    expect(q.canStartThreadTurn()).toBe(true);
    q.limitHit();
    expect(q.blockedUntil).toBe(now + 30 * 60_000);
  });

  it("スレッドの枠切れ: 発言は failed、notice「枠切れ・HH:MMに戻る」、release(quota, notBefore)。戻ったら続く", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_QUOTA_RESET_SEC: "1" }, env: { BATON_QUOTA_RESUME_MARGIN_MS: "0" } });
    env.api.ceoSays(COO_THREAD_ID, "[quota] [scenario-a] ショート動画の台本 10 本作りたい");
    const r = await env.step();
    expect(r?.outcome).toBe("released");
    const rel = env.api.releases.find((x) => x.kind === "thread")!;
    expect(rel.reason).toBe("quota");
    expect(rel.notBefore).not.toBeNull();
    const notice = env.api.agentMessages(COO_THREAD_ID).find((m) => m.kind === "notice")!;
    expect(notice.body).toMatch(/^枠切れ・\d\d:\d\dに戻る$/);
    expect(env.api.messagesOf(COO_THREAD_ID).some((m) => m.authorKind === "coo" && m.status === "failed")).toBe(true);
    expect(env.ctx.quota.canStartThreadTurn()).toBe(false);
    // 期限を過ぎたら claim を再開し、同じ受信箱で続く
    await new Promise((res) => setTimeout(res, 2100));
    env.api.threads.get(COO_THREAD_ID)!.notBefore = null;
    expect(env.ctx.quota.canStartThreadTurn()).toBe(true);
    await env.step();
    expect(env.api.agentMessages(COO_THREAD_ID).some((m) => m.body === "なんの動画ですか？")).toBe(true);
  }, 30_000);

  it("メンバーの枠切れ: セッションは quota_wait、指示は release(quota)。戻ったら --resume「枠が戻った。続けて」", async () => {
    env = await makeEnv({ fakeEnv: { FAKE_QUOTA_RESET_SEC: "1" }, env: { BATON_QUOTA_RESUME_MARGIN_MS: "0" } });
    env.api.ceoSays(COO_THREAD_ID, "作業 [quota@member]");
    await env.step();
    await env.step();
    const r = await env.step();
    expect(r?.outcome).toBe("released");
    const s = [...env.api.sessions.values()].find((x) => x.role === "member")!;
    expect(s.status).toBe("quota_wait");
    expect(env.api.releases.find((x) => x.kind === "instruction")!.reason).toBe("quota");
    await new Promise((res) => setTimeout(res, 2100));
    [...env.api.instructions.values()][0]!.notBefore = null;
    await env.step();
    expect(env.api.sessions.get(s.id)!.status).toBe("done");
    expect(env.api.transcript.some((t) => t.sessionId === s.id && String((t.body as { text?: string }).text ?? "").includes("枠が戻った"))).toBe(true);
  }, 30_000);

  it("しきい値（[warn] で 5 時間枠 0.85）: claim の quotaPaused が立ち、メンバーを起動しない", async () => {
    env = await makeEnv();
    env.api.ceoSays(COO_THREAD_ID, "[warn] 何か作って");
    await env.step(); // COO（rate_limit_event で 0.85）
    expect(env.ctx.quota.canStartMember()).toBe(false);
    await env.step(); // リーダー
    expect(await env.step()).toBeNull();
    expect(env.api.claims.at(-1)!.quotaPaused).toBe(true);
    expect([...env.api.sessions.values()].filter((s) => s.role === "member")).toHaveLength(0);
  }, 30_000);
});
