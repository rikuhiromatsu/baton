// 入力欄の宛先の決め方（13.3・13.5・D-54・D-71。F14）。画面から切り離した純粋関数
import { COO_THREAD_ID, TESTIDS, UI_TEXT_V2 } from "@baton/shared";
import type { DetailTarget } from "../state/ui.ts";

export type ScreenRoute =
  | { kind: "coo"; projectId: string | null }
  | { kind: "leader"; projectId: string }
  | { kind: "detail"; instructionId: string }
  | { kind: "org" }
  | { kind: "archive" }
  | { kind: "settings" }
  | { kind: "login" };

/** パスから画面を決める（URL が正本。D-70） */
export function parseRoute(pathname: string): ScreenRoute {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return { kind: "coo", projectId: null };
  if (p === "/login") return { kind: "login" };
  if (p === "/org") return { kind: "org" };
  if (p === "/archive") return { kind: "archive" };
  if (p === "/settings") return { kind: "settings" };
  let m = p.match(/^\/p\/([^/]+)\/leader$/);
  if (m) return { kind: "leader", projectId: decodeURIComponent(m[1]!) };
  m = p.match(/^\/p\/([^/]+)$/);
  if (m) return { kind: "coo", projectId: decodeURIComponent(m[1]!) };
  m = p.match(/^\/i\/([^/]+)$/);
  if (m) return { kind: "detail", instructionId: decodeURIComponent(m[1]!) };
  return { kind: "coo", projectId: null };
}

export type ComposerTarget = {
  /** 下書きのキー（宛先ごとに持つ） */
  draftKey: string;
  role: "coo" | "leader" | "member";
  /** 宛先の表示（→ COO / → リーダー · 台本 / 追加の依頼の相手） */
  name: string | null;
  aria: string;
  send: { kind: "thread"; threadId: string; instructionId: string | null } | { kind: "session"; sessionId: string; instructionId: string } | null;
  /** プロジェクトの指定（チップ）。宛先は COO のまま（D-71） */
  contextProject: { id: string; name: string } | null;
  inputTestId: string;
  sendTestId: string;
};

export type TargetContext = {
  leaderThreadIdOf: (projectId: string) => string | null;
  projectNameOf: (projectId: string) => string | null;
  detailTarget: DetailTarget;
  /** チップを外したプロジェクト */
  chipCleared: string | null;
};

const coo = (over: Partial<ComposerTarget> = {}): ComposerTarget => ({
  draftKey: "coo",
  role: "coo",
  name: UI_TEXT_V2.roles.coo,
  aria: UI_TEXT_V2.composer.cooAria,
  send: { kind: "thread", threadId: COO_THREAD_ID, instructionId: null },
  contextProject: null,
  inputTestId: TESTIDS.composerInput,
  sendTestId: TESTIDS.composerSend,
  ...over,
});

/** 画面と詳細のタブから、入力欄の宛先を決める。入力欄を出さない画面は null */
export function composerTarget(route: ScreenRoute, ctx: TargetContext): ComposerTarget | null {
  switch (route.kind) {
    case "login":
    case "settings":
      return null;
    case "org":
    case "archive":
      return coo();
    case "coo": {
      if (!route.projectId || ctx.chipCleared === route.projectId) return coo();
      const name = ctx.projectNameOf(route.projectId);
      return coo({ contextProject: name ? { id: route.projectId, name } : null });
    }
    case "leader": {
      const threadId = ctx.leaderThreadIdOf(route.projectId);
      return {
        draftKey: `thread:${threadId ?? `leader-${route.projectId}`}`,
        role: "leader",
        name: ctx.projectNameOf(route.projectId),
        aria: UI_TEXT_V2.composer.leaderAria,
        send: threadId ? { kind: "thread", threadId, instructionId: null } : null,
        contextProject: null,
        inputTestId: TESTIDS.composerInput,
        sendTestId: TESTIDS.composerSend,
      };
    }
    case "detail": {
      const t = ctx.detailTarget;
      const instructionId = route.instructionId;
      if (!t || t.instructionId !== instructionId || t.role === "coo") {
        return coo({
          draftKey: `detail:${instructionId}:coo`,
          send: { kind: "thread", threadId: t && t.instructionId === instructionId && t.role === "coo" ? t.threadId : COO_THREAD_ID, instructionId },
        });
      }
      if (t.role === "leader") {
        return {
          draftKey: `detail:${instructionId}:leader`,
          role: "leader",
          name: t.projectId ? ctx.projectNameOf(t.projectId) : null,
          aria: UI_TEXT_V2.composer.leaderAria,
          send: { kind: "thread", threadId: t.threadId, instructionId },
          contextProject: null,
          inputTestId: TESTIDS.composerInput,
          sendTestId: TESTIDS.composerSend,
        };
      }
      return {
        draftKey: `session:${t.sessionId}`,
        role: "member",
        name: null,
        aria: UI_TEXT_V2.composer.followupAria,
        send: { kind: "session", sessionId: t.sessionId, instructionId },
        contextProject: null,
        inputTestId: TESTIDS.followupInput,
        sendTestId: TESTIDS.followupSend,
      };
    }
  }
}
