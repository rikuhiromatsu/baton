// 中断した work の再開で、前回の書き込みを重ねないよう注意を入れる（D-34、Codex 指摘）
import { describe, expect, it } from "vitest";
import { buildMemberFirstUser, type MemberInput } from "../src/prompts/member.ts";

const base: MemberInput = {
  body: "レシピを作って",
  feedback: null,
  decisions: [],
  projectName: "テスト",
  memberName: "調査担当",
  specialty: "",
  leaderName: "リーダー",
  taskKey: "t1",
  taskTitle: "表を作る",
  taskSpec: "recipe.md に書く",
  dependencies: [],
  maxTurns: 12,
  decisionsLeft: 3,
  limits: { fsReadMaxChars: 20000, fsWriteMaxBytes: 1048576, webFetchMaxChars: 20000 },
};

describe("メンバーの再開時の注意", () => {
  it("初回は注意を入れない", () => {
    expect(buildMemberFirstUser(base)).not.toContain("注意: 再開");
  });
  it("再開時は、既にある内容を重ねて追記しないよう伝える", () => {
    const text = buildMemberFirstUser({ ...base, resumed: true });
    expect(text).toContain("注意: 再開");
    expect(text).toContain("fs_append");
  });
});
