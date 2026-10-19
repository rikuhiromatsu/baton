// テスト用の小道具
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstructionSummary, ListInstructionsOutput } from "@baton/shared";
import { setCsrfToken, setTransport, type FetchLike } from "../../src/web/api/client.ts";
import { qk } from "../../src/web/api/keys.ts";

export function makeQc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
}

export function Wrap({ qc, children }: { qc: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
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
    notBefore: null,
    error: null,
    taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...over,
  };
}

export function seedList(qc: QueryClient, items: InstructionSummary[], view: "active" | "archived" = "active"): void {
  qc.setQueryData<ListInstructionsOutput>(qk.list(view), { items, nextCursor: null });
}

export function listItems(qc: QueryClient, view: "active" | "archived" = "active"): InstructionSummary[] {
  return qc.getQueryData<ListInstructionsOutput>(qk.list(view))?.items ?? [];
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

export function json(status: number, body: unknown): Response {
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
