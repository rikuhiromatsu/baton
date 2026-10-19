// テスト用の小道具
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import type { InstructionSummary, ListInstructionsOutput, ThreadMessage, ThreadSummary } from "@baton/shared";
import { App } from "../../src/web/App.tsx";
import { setCsrfToken, setTransport, type FetchLike } from "../../src/web/api/client.ts";
import { qk } from "../../src/web/api/keys.ts";
import { createMock, mockRawLog, type MockHandle } from "../../src/web/api/mock.ts";
import { setSocketFactory } from "../../src/web/api/ws.ts";
import { registerMockHooks, setMockMode } from "../../src/web/lib/env.ts";
import { setPushDriver } from "../../src/web/lib/push.ts";
import { setTailnetDriver } from "../../src/web/lib/tailnet.ts";
import { createAppRouter } from "../../src/web/router.tsx";
import { useTailnet } from "../../src/web/state/tailnet.ts";
import { useToasts } from "../../src/web/state/toasts.ts";
import { useUi } from "../../src/web/state/ui.ts";

export function makeQc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
}

export function Wrap({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Link を使う部品のために、最小のルーターで包む */
export function RouterWrap({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  const rootRoute = createRootRoute({ component: () => <>{children}</> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  );
}

let seq = 0;
export function summary(over: Partial<InstructionSummary> = {}): InstructionSummary {
  seq += 1;
  const now = Date.now();
  return {
    id: `id-${seq}`,
    clientId: `client-${seq}`,
    body: `本文 ${seq}`,
    title: null,
    status: "queued",
    statusChangedAt: now,
    projectId: null,
    projectName: null,
    resultSummary: null,
    openDecisionId: null,
    openDecisionCount: 0,
    activeSessionCount: 0,
    activity: null,
    revision: 1,
    phase: null,
    talkingWithCeo: false,
    costUsdEst: 0,
    notBefore: null,
    error: null,
    taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
    activeAgents: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...over,
  };
}

export function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  seq += 1;
  const now = Date.now();
  return {
    id: `m-${seq}`,
    threadId: "thread-coo",
    seq,
    authorKind: "coo",
    authorAgentId: "agent-coo",
    authorName: "COO",
    kind: "chat",
    body: `発言 ${seq}`,
    instructionId: null,
    sessionId: null,
    ref: {},
    status: "complete",
    reaction: null,
    notify: false,
    clientId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-coo",
    kind: "coo",
    projectId: null,
    projectName: null,
    agentName: "COO",
    status: "idle",
    activity: null,
    awaitingReply: false,
    unread: 0,
    lastMessage: null,
    talkingWithCeo: false,
    lastSeq: 0,
    lastReadSeq: 0,
    ...over,
  };
}

export function seedList(qc: QueryClient, items: InstructionSummary[], view: "active" | "archived" = "active"): void {
  qc.setQueryData<ListInstructionsOutput>(qk.list(view), { items, nextCursor: null });
}

export type Call = { method: string; path: string; body: unknown; headers: Headers };

/** 呼び出しを記録する fetch。handler が Response を返す */
export function recordingTransport(handler: (call: Call) => Response | Promise<Response>): { calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchLike = async (input, init = {}) => {
    const call: Call = {
      method: (init.method ?? "GET").toUpperCase(),
      path: input,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    };
    calls.push(call);
    return handler(call);
  };
  setTransport(f);
  setCsrfToken("csrf-test");
  return { calls };
}

export function json(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 押しっぱなしにしないプッシュの差し替え（設定・案内のテスト用） */
export const stubPush = {
  support: () => "supported" as const,
  permission: () => "granted" as const,
  requestPermission: async () => "granted" as NotificationPermission,
  subscribe: async () => ({ endpoint: "https://web.push.apple.com/test-device", keys: { p256dh: "p", auth: "a" } }),
  current: async () => null,
  unsubscribe: async () => {},
};

let current: MockHandle | null = null;

/** モックのバックエンドでアプリ全体を描く（画面のテスト用。止めた絵＝still で、動く流れを始めない） */
export async function bootApp(path: string, opts: { loggedOut?: boolean; empty?: boolean; still?: boolean; speed?: number } = {}) {
  current?.backend.dispose();
  const handle = createMock({ loggedOut: opts.loggedOut, empty: opts.empty, still: opts.still ?? true, speed: opts.speed ?? 50 });
  current = handle;
  await handle.backend.ready;
  setMockMode(true);
  setTransport(handle.backend.fetch);
  setCsrfToken(null);
  setSocketFactory(handle.backend.createSocket);
  setTailnetDriver({ fetch: async () => new Response("{}", { status: 200 }), openRawLog: mockRawLog });
  setPushDriver(stubPush);
  registerMockHooks({ login: () => handle.backend.login() });
  useTailnet.setState({ url: null, ok: false });
  useToasts.setState({ toast: null });
  useUi.setState({ listRevealed: true, actionMenu: null, sendBackFor: null, messageMenu: null, onboardingOpen: false, detailTarget: null, drawerOpen: false, cardsSheetOpen: false, quotaSheetOpen: false });
  try {
    localStorage.setItem("mock:baton:onboarded", "1");
  } catch {
    // 無視
  }
  const qc = makeQc();
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
  const view = render(<App queryClient={qc} router={router} persist={false} />);
  return { qc, router, handle, backend: handle.backend, view };
}

export function disposeApp(): void {
  current?.backend.dispose();
  current = null;
  setMockMode(false);
  setPushDriver(null);
}
