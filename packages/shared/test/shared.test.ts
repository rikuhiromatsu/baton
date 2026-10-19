import { describe, expect, it } from "vitest";
import {
  CEO_ACTIONS,
  CooRouteAction,
  CreateInstructionInput,
  INSTRUCTION_STATUSES,
  LeaderPlanAction,
  MemberStepAction,
  STAGE_SCHEMAS,
  SWIPE_MAP,
  TransitionInput,
  canSystemTransition,
  extractFirstJsonObject,
  nextStatus,
  parseStageAction,
  stageJsonSchema,
  type CeoAction,
  type InstructionStatus,
} from "../src/index.ts";

// 設計書 3.4 の CEO 操作の遷移（restore を除く）
const ALLOWED: Array<[InstructionStatus, CeoAction, InstructionStatus]> = [
  ["review", "approve", "done"],
  ["review", "send_back", "queued"],
  ["queued", "cancel", "canceled"],
  ["running", "cancel", "canceled"],
  ["needs_decision", "cancel", "canceled"],
  ["done", "archive", "archived"],
  ["failed", "archive", "archived"],
  ["canceled", "archive", "archived"],
  ["failed", "retry", "queued"],
  ["canceled", "retry", "queued"],
];

describe("S1 nextStatus", () => {
  it("3.4 の遷移をすべて許し、それ以外をすべて拒否する", () => {
    for (const from of INSTRUCTION_STATUSES) {
      for (const action of CEO_ACTIONS) {
        if (action === "restore") continue;
        const expected = ALLOWED.find(([f, a]) => f === from && a === action)?.[2] ?? null;
        expect(nextStatus(from, action), `${from} --${action}-->`).toBe(expected);
      }
    }
  });

  it("restore はアーカイブ前の done / canceled / failed にだけ戻す", () => {
    expect(nextStatus("archived", "restore", "done")).toBe("done");
    expect(nextStatus("archived", "restore", "canceled")).toBe("canceled");
    expect(nextStatus("archived", "restore", "failed")).toBe("failed");
    expect(nextStatus("archived", "restore", "review")).toBeNull();
    expect(nextStatus("archived", "restore")).toBeNull();
    for (const from of INSTRUCTION_STATUSES) {
      if (from !== "archived") expect(nextStatus(from, "restore", "done")).toBeNull();
    }
  });

  it("システムの遷移は 3.4 の矢印だけ", () => {
    expect(canSystemTransition("queued", "running")).toBe(true);
    expect(canSystemTransition("running", "review")).toBe(true);
    expect(canSystemTransition("running", "needs_decision")).toBe(true);
    expect(canSystemTransition("needs_decision", "queued")).toBe(true);
    expect(canSystemTransition("review", "done")).toBe(false);
    expect(canSystemTransition("queued", "review")).toBe(false);
  });
});

describe("S2 SWIPE_MAP", () => {
  it("3.5 の表と一致する", () => {
    expect(SWIPE_MAP).toEqual({
      queued: { right: null, left: "cancel" },
      running: { right: null, left: "cancel" },
      needs_decision: { right: "open_decision", left: "cancel" },
      review: { right: "approve", left: "send_back" },
      done: { right: "archive", left: null },
      failed: { right: "retry", left: "archive" },
      canceled: { right: "retry", left: "archive" },
      archived: { right: "restore", left: null },
    });
  });

  it("フリックで選べる操作は（restore 以外）その状態から nextStatus で動ける", () => {
    for (const status of INSTRUCTION_STATUSES) {
      for (const dir of ["right", "left"] as const) {
        const outcome = SWIPE_MAP[status][dir];
        if (outcome === null || outcome === "open_decision" || outcome === "restore") continue;
        expect(nextStatus(status, outcome), `${status} ${dir}`).not.toBeNull();
      }
    }
  });
});

describe("S3 zod スキーマの境界", () => {
  it("CreateInstructionInput", () => {
    const clientId = crypto.randomUUID();
    expect(CreateInstructionInput.safeParse({ clientId, body: "調べて" }).success).toBe(true);
    expect(CreateInstructionInput.safeParse({ clientId, body: "   " }).success).toBe(false);
    expect(CreateInstructionInput.safeParse({ clientId, body: "a".repeat(8000) }).success).toBe(true);
    expect(CreateInstructionInput.safeParse({ clientId, body: "a".repeat(8001) }).success).toBe(false);
    expect(CreateInstructionInput.safeParse({ clientId: "x", body: "a" }).success).toBe(false);
  });

  it("TransitionInput", () => {
    expect(TransitionInput.safeParse({ action: "approve", expectedStatus: "review" }).success).toBe(true);
    expect(TransitionInput.safeParse({ action: "delete", expectedStatus: "review" }).success).toBe(false);
    expect(TransitionInput.safeParse({ action: "send_back", expectedStatus: "review", comment: "a".repeat(2001) }).success).toBe(false);
  });

  it("CooRouteAction の slug・メンバー数", () => {
    const base = {
      kind: "route",
      title: "調査",
      brief: "方針",
      project: { mode: "new", name: "調査", slug: "research", summary: "", leader: { name: "L", specialty: "" }, members: [{ name: "M", specialty: "" }] },
    };
    expect(CooRouteAction.safeParse(base).success).toBe(true);
    expect(CooRouteAction.safeParse({ ...base, project: { ...base.project, slug: "Bad Slug" } }).success).toBe(false);
    expect(CooRouteAction.safeParse({ ...base, project: { ...base.project, members: [] } }).success).toBe(false);
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `M${i}`, specialty: "" }));
    expect(CooRouteAction.safeParse({ ...base, project: { ...base.project, members: four } }).success).toBe(false);
  });

  it("LeaderPlanAction のタスク数とキー", () => {
    const t = (key: string) => ({ key, title: "x", spec: "y", assignee: "M", dependsOn: [] });
    expect(LeaderPlanAction.safeParse({ kind: "plan", tasks: [t("t1")] }).success).toBe(true);
    expect(LeaderPlanAction.safeParse({ kind: "plan", tasks: [] }).success).toBe(false);
    expect(LeaderPlanAction.safeParse({ kind: "plan", tasks: [t("x1")] }).success).toBe(false);
    expect(LeaderPlanAction.safeParse({ kind: "plan", tasks: Array.from({ length: 7 }, (_, i) => t(`t${i + 1}`)) }).success).toBe(false);
  });

  it("MemberStepAction の道具名", () => {
    expect(MemberStepAction.safeParse({ kind: "tool", tool: "fs_write", args: { path: "a.md", content: "x" }, why: "" }).success).toBe(true);
    expect(MemberStepAction.safeParse({ kind: "tool", tool: "shell", args: {}, why: "" }).success).toBe(false);
  });
});

describe("S4 JSON Schema と取り出し", () => {
  it("全段階のスキーマが JSON Schema になる", () => {
    for (const stage of Object.keys(STAGE_SCHEMAS) as Array<keyof typeof STAGE_SCHEMAS>) {
      const { name, schema } = stageJsonSchema(stage);
      expect(name).toBe(stage);
      expect(typeof schema).toBe("object");
      expect(JSON.stringify(schema).length).toBeGreaterThan(20);
    }
  });

  it("前後の文章や囲みがあっても最初の JSON を取り出す", () => {
    expect(extractFirstJsonObject('はい。\n```json\n{"kind":"final","report":"a {b} \\"c\\""}\n```')).toEqual({
      kind: "final",
      report: 'a {b} "c"',
    });
    expect(() => extractFirstJsonObject("JSON なし")).toThrow();
    expect(() => extractFirstJsonObject('{"a": 1')).toThrow();
  });

  it("parseStageAction が検査まで行う", () => {
    expect(parseStageAction("coo_final", '{"kind":"final","report":"完了"}')).toEqual({ kind: "final", report: "完了" });
    expect(() => parseStageAction("coo_final", '{"kind":"final","report":""}')).toThrow();
  });
});
