// 画面が使うクエリ
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { COO_THREAD_ID, type ListMessagesOutput, type TranscriptOutput } from "@baton/shared";
import { ApiError, api, listAllInstructions, setCsrfToken } from "./client.ts";
import { mergeMessages, mergeTranscript } from "./cache.ts";
import { qk } from "./keys.ts";

export function noRetryOn4xx(count: number, err: unknown): boolean {
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
  return useQuery({ queryKey: qk.list("active"), queryFn: ({ signal }) => listAllInstructions("active", signal), retry: noRetryOn4xx, enabled });
}

export function useArchivedList(enabled = true) {
  return useQuery({ queryKey: qk.list("archived"), queryFn: ({ signal }) => listAllInstructions("archived", signal), retry: noRetryOn4xx, enabled });
}

export function useInstructionDetail(id: string) {
  return useQuery({ queryKey: qk.detail(id), queryFn: ({ signal }) => api.getInstruction(id, signal), retry: noRetryOn4xx });
}

export function useDiff(id: string, enabled: boolean) {
  return useQuery({ queryKey: qk.diff(id), queryFn: ({ signal }) => api.diff(id, signal), retry: noRetryOn4xx, enabled });
}

export function useThreads(enabled = true) {
  return useQuery({ queryKey: qk.threads, queryFn: ({ signal }) => api.threads(signal), retry: noRetryOn4xx, enabled });
}

/** 最新 100 件。WebSocket で先に届いた発言とまぜる（取り直しで消さない） */
export function messagesQueryFn(qc: QueryClient, threadId: string) {
  return async ({ signal }: { signal?: AbortSignal }): Promise<ListMessagesOutput> => {
    const res = await api.messages(threadId, null, signal);
    const cached = qc.getQueryData<ListMessagesOutput>(qk.messages(threadId));
    if (!cached) return res;
    const oldest = res.items[0]?.seq ?? Infinity;
    // 前に読み込んだ古い発言（上へスクロールして足した分）は残す
    const older = cached.items.filter((m) => m.seq < oldest);
    return { items: mergeMessages(older, res.items), hasMoreBefore: older.length > 0 ? cached.hasMoreBefore : res.hasMoreBefore };
  };
}

export function useMessages(qc: QueryClient, threadId: string | null) {
  return useQuery({
    queryKey: qk.messages(threadId ?? COO_THREAD_ID),
    queryFn: messagesQueryFn(qc, threadId ?? COO_THREAD_ID),
    retry: noRetryOn4xx,
    enabled: threadId !== null,
    staleTime: 30_000,
  });
}

/** 上へスクロールしたら古い発言を足す */
export async function loadOlderMessages(qc: QueryClient, threadId: string): Promise<void> {
  const cur = qc.getQueryData<ListMessagesOutput>(qk.messages(threadId));
  if (!cur || !cur.hasMoreBefore || cur.items.length === 0) return;
  const res = await api.messages(threadId, cur.items[0]!.seq);
  qc.setQueryData<ListMessagesOutput>(qk.messages(threadId), (old) =>
    old ? { items: mergeMessages(old.items, res.items), hasMoreBefore: res.hasMoreBefore } : old,
  );
}

export function useProposal(id: string | null) {
  return useQuery({
    queryKey: qk.proposal(id ?? "none"),
    queryFn: async ({ signal }) => (await api.proposal(id!, signal)).proposal,
    enabled: id !== null,
    retry: noRetryOn4xx,
    staleTime: 60_000,
  });
}

/** トランスクリプト（最新 200 件。instructionId で COO・リーダーのセッションをその指示の分だけに絞る） */
export function transcriptQueryFn(qc: QueryClient, sessionId: string, instructionId: string | null) {
  return async ({ signal }: { signal?: AbortSignal }): Promise<TranscriptOutput> => {
    const res = await api.transcript(sessionId, { instructionId }, signal);
    const cached = qc.getQueryData<TranscriptOutput>(qk.transcript(sessionId, instructionId));
    if (!cached) return res;
    return { items: mergeTranscript(cached.items, res.items), hasMoreBefore: res.hasMoreBefore };
  };
}

export function useTranscript(qc: QueryClient, sessionId: string | null, instructionId: string | null) {
  return useQuery({
    queryKey: qk.transcript(sessionId ?? "none", instructionId),
    queryFn: transcriptQueryFn(qc, sessionId ?? "none", instructionId),
    enabled: sessionId !== null,
    retry: noRetryOn4xx,
    staleTime: 30_000,
  });
}

export async function loadOlderTranscript(qc: QueryClient, sessionId: string, instructionId: string | null): Promise<void> {
  const key = qk.transcript(sessionId, instructionId);
  const cur = qc.getQueryData<TranscriptOutput>(key);
  if (!cur || !cur.hasMoreBefore || cur.items.length === 0) return;
  const res = await api.transcript(sessionId, { instructionId, before: cur.items[0]!.seq });
  qc.setQueryData<TranscriptOutput>(key, (old) => (old ? { items: mergeTranscript(old.items, res.items), hasMoreBefore: res.hasMoreBefore } : old));
}

export function useTranscriptItem(id: string | null) {
  return useQuery({
    queryKey: qk.transcriptItem(id ?? "none"),
    queryFn: ({ signal }) => api.transcriptItem(id!, signal),
    enabled: id !== null,
    retry: noRetryOn4xx,
    staleTime: Infinity,
  });
}

export function useSidebar(enabled = true) {
  return useQuery({ queryKey: qk.sidebar, queryFn: ({ signal }) => api.sidebar(signal), retry: noRetryOn4xx, enabled });
}

export function useOrg(enabled = true) {
  return useQuery({ queryKey: qk.org, queryFn: ({ signal }) => api.org(signal), retry: noRetryOn4xx, enabled });
}

export function useProjects(enabled = true) {
  return useQuery({ queryKey: qk.projects, queryFn: ({ signal }) => api.projects(signal), retry: noRetryOn4xx, enabled });
}

export function useRepos(enabled = true) {
  return useQuery({ queryKey: qk.repos, queryFn: ({ signal }) => api.repos(signal), retry: noRetryOn4xx, enabled, staleTime: 60_000 });
}

export function useProfiles(enabled = true) {
  return useQuery({ queryKey: qk.profiles, queryFn: ({ signal }) => api.profiles(signal), retry: noRetryOn4xx, enabled, staleTime: 5 * 60_000 });
}

export function useQuota(enabled = true) {
  return useQuery({ queryKey: qk.quota, queryFn: ({ signal }) => api.quota(signal), retry: noRetryOn4xx, enabled, staleTime: 60_000 });
}

export function usePushSubscriptions(enabled = true) {
  return useQuery({ queryKey: qk.pushSubscriptions, queryFn: ({ signal }) => api.pushSubscriptions(signal), retry: noRetryOn4xx, enabled });
}

export function useBotTokens(enabled = true) {
  return useQuery({ queryKey: qk.botTokens, queryFn: ({ signal }) => api.botTokens(signal), retry: noRetryOn4xx, enabled });
}

export function useBotAudit(id: string | null) {
  return useQuery({
    queryKey: qk.botAudit(id ?? "none"),
    queryFn: ({ signal }) => api.botAudit(id!, null, signal),
    enabled: id !== null,
    retry: noRetryOn4xx,
  });
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
