// F14 宛先の決め方（13.3・13.5・D-54・D-71）: 宛先はいつも COO、/p/:id はチップ、リーダーのスレッドの中だけリーダー、詳細はタブで決まる
import { describe, expect, it } from "vitest";
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import { composerTarget, parseRoute, type TargetContext } from "../../src/web/lib/target.ts";

const ctx = (over: Partial<TargetContext> = {}): TargetContext => ({
  leaderThreadIdOf: (pid) => (pid === "p1" ? "thread-leader-p1" : null),
  projectNameOf: (pid) => (pid === "p1" ? "台本" : null),
  detailTarget: null,
  chipCleared: null,
  ...over,
});

describe("F14 宛先の決め方", () => {
  it("パスから画面を決める", () => {
    expect(parseRoute("/")).toEqual({ kind: "coo", projectId: null });
    expect(parseRoute("/p/p1")).toEqual({ kind: "coo", projectId: "p1" });
    expect(parseRoute("/p/p1/leader")).toEqual({ kind: "leader", projectId: "p1" });
    expect(parseRoute("/i/abc")).toEqual({ kind: "detail", instructionId: "abc" });
    expect(parseRoute("/org")).toEqual({ kind: "org" });
    expect(parseRoute("/settings/")).toEqual({ kind: "settings" });
    expect(parseRoute("/login")).toEqual({ kind: "login" });
  });

  it("ホームは COO 宛て（チップなし）", () => {
    const t = composerTarget(parseRoute("/"), ctx())!;
    expect(t.role).toBe("coo");
    expect(t.aria).toBe(UI_TEXT_V2.composer.cooAria);
    expect(t.send).toEqual({ kind: "thread", threadId: COO_THREAD_ID, instructionId: null });
    expect(t.contextProject).toBeNull();
    expect(t.draftKey).toBe("coo");
  });

  it("プロジェクトを選んでいても宛先は COO のまま、チップが付く。外したら付かない", () => {
    const t = composerTarget(parseRoute("/p/p1"), ctx())!;
    expect(t.role).toBe("coo");
    expect(t.send).toMatchObject({ threadId: COO_THREAD_ID });
    expect(t.contextProject).toEqual({ id: "p1", name: "台本" });
    expect(composerTarget(parseRoute("/p/p1"), ctx({ chipCleared: "p1" }))!.contextProject).toBeNull();
  });

  it("リーダーのスレッドの中だけリーダー宛て", () => {
    const t = composerTarget(parseRoute("/p/p1/leader"), ctx())!;
    expect(t.role).toBe("leader");
    expect(t.aria).toBe(UI_TEXT_V2.composer.leaderAria);
    expect(t.send).toEqual({ kind: "thread", threadId: "thread-leader-p1", instructionId: null });
    expect(t.name).toBe("台本");
    expect(t.inputTestId).toBe(TESTIDS.composerInput);
    // スレッドがまだ分からないときは送らない（下書きは残る）
    expect(composerTarget(parseRoute("/p/zz/leader"), ctx())!.send).toBeNull();
  });

  it("詳細: COO・リーダーのタブはスレッドへの発言（指示付き）、メンバーのタブは追加の依頼", () => {
    const coo = composerTarget(parseRoute("/i/i1"), ctx())!;
    expect(coo.role).toBe("coo");
    expect(coo.send).toEqual({ kind: "thread", threadId: COO_THREAD_ID, instructionId: "i1" });
    const leader = composerTarget(parseRoute("/i/i1"), ctx({ detailTarget: { instructionId: "i1", role: "leader", threadId: "thread-leader-p1", projectId: "p1" } }))!;
    expect(leader.aria).toBe(UI_TEXT_V2.composer.leaderAria);
    expect(leader.send).toEqual({ kind: "thread", threadId: "thread-leader-p1", instructionId: "i1" });
    const member = composerTarget(parseRoute("/i/i1"), ctx({ detailTarget: { instructionId: "i1", role: "member", sessionId: "s1", running: true } }))!;
    expect(member.role).toBe("member");
    expect(member.aria).toBe(UI_TEXT_V2.composer.followupAria);
    expect(member.send).toEqual({ kind: "session", sessionId: "s1", instructionId: "i1" });
    expect(member.inputTestId).toBe(TESTIDS.followupInput);
    expect(member.sendTestId).toBe(TESTIDS.followupSend);
    // 別の指示のタブの情報は使わない
    expect(composerTarget(parseRoute("/i/i2"), ctx({ detailTarget: { instructionId: "i1", role: "member", sessionId: "s1", running: true } }))!.role).toBe("coo");
  });

  it("組織図・アーカイブは COO 宛て、設定とログインは入力欄を出さない", () => {
    expect(composerTarget(parseRoute("/org"), ctx())!.role).toBe("coo");
    expect(composerTarget(parseRoute("/archive"), ctx())!.role).toBe("coo");
    expect(composerTarget(parseRoute("/settings"), ctx())).toBeNull();
    expect(composerTarget(parseRoute("/login"), ctx())).toBeNull();
  });
});
