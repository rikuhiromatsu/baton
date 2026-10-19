import { describe, expect, it } from "vitest";
import {
  CEO_ACTIONS,
  INSTRUCTION_STATUSES,
  PostMessageInput,
  SWIPE_MAP,
  TransitionInput,
  AnswerDecisionInput,
  CreateBotTokenInput,
  CreatePushSubscriptionInput,
  RunnerInstructionPatch,
  canReopen,
  canSystemTransition,
  displayGroup,
  isAllowedPushEndpoint,
  nextStatus,
  swipeActionFor,
  API_PATHS,
  TEST_API_PATHS,
  ERROR_CODES,
  type CeoAction,
  type InstructionStatus,
} from "../src/index.ts";

// v1 設計書 3.4 の CEO 操作の遷移（restore を除く）。v2 でも同じ（DESIGN-v2 4.4）
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

describe("S1 nextStatus と v2 の遷移", () => {
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

  it("システムの遷移は v1 の矢印 ＋ v2 の reopen・回答での再開だけ", () => {
    const expected: Array<[InstructionStatus, InstructionStatus]> = [
      ["queued", "running"],
      ["running", "queued"],
      ["running", "needs_decision"],
      ["running", "review"],
      ["running", "failed"],
      ["needs_decision", "queued"],
      ["needs_decision", "running"],
      ["review", "running"],
      ["done", "running"],
    ];
    for (const from of INSTRUCTION_STATUSES) {
      for (const to of INSTRUCTION_STATUSES) {
        const ok = expected.some(([f, t]) => f === from && t === to);
        expect(canSystemTransition(from, to), `${from} -> ${to}`).toBe(ok);
      }
    }
    expect(canReopen("review")).toBe(true);
    expect(canReopen("done")).toBe(true);
    expect(canReopen("failed")).toBe(false);
    expect(canReopen("archived")).toBe(false);
  });
});

describe("S2 フリック（SWIPE_MAP・displayGroup・swipeActionFor）", () => {
  it("まとまりのフリックは v1 3.5 の表と一致する", () => {
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

  it("開いた判断（承認を含む）のある running・queued は判断待ちのまとまり", () => {
    expect(displayGroup({ status: "running", openDecisionCount: 1 })).toBe("needs_decision");
    expect(displayGroup({ status: "queued", openDecisionCount: 2 })).toBe("needs_decision");
    expect(displayGroup({ status: "running", openDecisionCount: 0 })).toBe("running");
    expect(displayGroup({ status: "review", openDecisionCount: 1 })).toBe("review");
    expect(displayGroup({ status: "done", openDecisionCount: 1 })).toBe("done");
  });

  it("承認待ちの running の右フリックは判断シートを開くだけ（承認はフリックで許可しない）", () => {
    expect(swipeActionFor({ status: "running", openDecisionCount: 1 }, "right")).toBe("open_decision");
    expect(swipeActionFor({ status: "running", openDecisionCount: 1 }, "left")).toBe("cancel");
    expect(swipeActionFor({ status: "running", openDecisionCount: 0 }, "right")).toBeNull();
  });

  it("判断が無ければ swipeActionFor は SWIPE_MAP と同じ", () => {
    for (const status of INSTRUCTION_STATUSES) {
      for (const dir of ["right", "left"] as const) {
        expect(swipeActionFor({ status, openDecisionCount: 0 }, dir), `${status} ${dir}`).toBe(SWIPE_MAP[status][dir]);
      }
    }
  });
});

describe("S3 zod スキーマの境界", () => {
  it("PostMessageInput（CEO の発言）", () => {
    const clientId = crypto.randomUUID();
    expect(PostMessageInput.safeParse({ clientId, body: "台本を作りたい" }).success).toBe(true);
    expect(PostMessageInput.safeParse({ clientId, body: "   " }).success).toBe(false);
    expect(PostMessageInput.safeParse({ clientId, body: "a".repeat(8000) }).success).toBe(true);
    expect(PostMessageInput.safeParse({ clientId, body: "a".repeat(8001) }).success).toBe(false);
    expect(PostMessageInput.safeParse({ clientId: "x", body: "a" }).success).toBe(false);
    expect(PostMessageInput.safeParse({ clientId, body: "a", contextProjectId: "p1" }).success).toBe(true);
  });

  it("TransitionInput", () => {
    expect(TransitionInput.safeParse({ action: "approve", expectedStatus: "review" }).success).toBe(true);
    expect(TransitionInput.safeParse({ action: "delete", expectedStatus: "review" }).success).toBe(false);
    expect(TransitionInput.safeParse({ action: "send_back", expectedStatus: "review", comment: "a".repeat(2001) }).success).toBe(false);
  });

  it("AnswerDecisionInput は answer か verdict のどちらかが要る", () => {
    expect(AnswerDecisionInput.safeParse({ verdict: "allow" }).success).toBe(true);
    expect(AnswerDecisionInput.safeParse({ answer: "続けて" }).success).toBe(true);
    expect(AnswerDecisionInput.safeParse({}).success).toBe(false);
    expect(AnswerDecisionInput.safeParse({ verdict: "maybe" }).success).toBe(false);
  });

  it("RunnerInstructionPatch は版と reopen を持てる", () => {
    expect(RunnerInstructionPatch.safeParse({ status: "review", expectedRevision: 2, resultSummary: "報告" }).success).toBe(true);
    expect(RunnerInstructionPatch.safeParse({ status: "done" }).success).toBe(false);
    expect(RunnerInstructionPatch.safeParse({ expectedRevision: 0 }).success).toBe(false);
  });

  it("CreateBotTokenInput のスコープ", () => {
    expect(CreateBotTokenInput.safeParse({ name: "Grok 秘書", scopes: ["read", "message"] }).success).toBe(true);
    expect(CreateBotTokenInput.safeParse({ name: "Grok 秘書", scopes: [] }).success).toBe(false);
    expect(CreateBotTokenInput.safeParse({ name: "Grok 秘書", scopes: ["admin"] }).success).toBe(false);
  });

  it("通知の送り先は許可したホストの https だけ（SSRF 対策。10.3）", () => {
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://evil.example.com/push.apple.com")).toBe(false);
    expect(isAllowedPushEndpoint("https://push.apple.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("http://localhost:8799/push/a")).toBe(false);
    expect(isAllowedPushEndpoint("http://localhost:8799/push/a", { allowE2E: true })).toBe(true);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    const keys = { p256dh: "BPk", auth: "x" };
    expect(CreatePushSubscriptionInput.safeParse({ endpoint: "https://web.push.apple.com/a", keys }).success).toBe(true);
  });

  it("v1 の Workers AI と指示の直接作成は契約から消えている（12.1）", () => {
    const paths = JSON.stringify(Object.fromEntries(Object.entries(API_PATHS).map(([k, v]) => [k, typeof v === "function" ? (v as (...a: string[]) => string)("x", "y") : v])));
    expect(paths).not.toContain("/api/runner/ai/");
    expect(paths).not.toContain("/api/usage/");
    expect(paths).not.toContain("/events");
    expect(ERROR_CODES).not.toContain("ai_unavailable" as never);
    expect(ERROR_CODES).not.toContain("ai_quota" as never);
    // 本番の成果物に /api/test/ を残さないため、テスト用のパスは別の定数にある
    expect(paths).not.toContain("/api/test/");
    expect(Object.values(TEST_API_PATHS).every((p) => p.startsWith("/api/test/"))).toBe(true);
  });
});
