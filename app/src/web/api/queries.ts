// 画面が使うクエリ
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { ListEventsOutput } from "@baton/shared";
import { ApiError, api, listAllInstructions, setCsrfToken } from "./client.ts";
import { fetchActiveList } from "./actions.ts";
import { qk } from "./keys.ts";

function noRetryOn4xx(count: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return count < 2;
}

export async function fetchSession(signal?: AbortSignal) {
  const s = await api.session(signal);
  setCsrfToken(s.csrfToken);
  return s;
}

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: ({ signal }) => fetchSession(signal), retry: noRetryOn4xx, staleTime: 60_000 });
}

export function useActiveList(enabled = true) {
  return useQuery({ queryKey: qk.list("active"), queryFn: ({ signal }) => fetchActiveList(signal), retry: noRetryOn4xx, enabled });
}

export function useArchivedList(enabled = true) {
  return useQuery({ queryKey: qk.list("archived"), queryFn: ({ signal }) => listAllInstructions("archived", signal), retry: noRetryOn4xx, enabled });
}

export function useInstructionDetail(id: string) {
  return useQuery({ queryKey: qk.detail(id), queryFn: ({ signal }) => api.getInstruction(id, signal), retry: noRetryOn4xx });
}

/** ログは手元の最後の seq から続きを取って足す（4.5 の欠落対策） */
export function eventsQueryFn(qc: QueryClient, id: string) {
  return async ({ signal }: { signal?: AbortSignal }): Promise<ListEventsOutput> => {
    const cached = qc.getQueryData<ListEventsOutput>(qk.events(id));
    const after = cached && cached.items.length > 0 ? cached.items[cached.items.length - 1]!.seq : -1;
    const res = await api.listEvents(id, after, signal);
    const merged = new Map<number, ListEventsOutput["items"][number]>();
    for (const e of cached?.items ?? []) merged.set(e.seq, e);
    for (const e of res.items) merged.set(e.seq, e);
    return { items: [...merged.values()].sort((a, b) => a.seq - b.seq) };
  };
}

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: ({ signal }) => api.projects(signal), retry: noRetryOn4xx });
}

export function useUsage(enabled = true) {
  return useQuery({ queryKey: qk.usage, queryFn: ({ signal }) => api.usageToday(signal), retry: noRetryOn4xx, enabled, staleTime: 60_000 });
}

export function useArtifact(id: string | null) {
  return useQuery({
    queryKey: qk.artifact(id ?? "none"),
    queryFn: ({ signal }) => api.artifact(id!, signal),
    enabled: id !== null,
    retry: noRetryOn4xx,
    staleTime: Infinity,
  });
}
