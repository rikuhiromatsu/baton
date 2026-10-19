// アプリの組み立て（main とテストの両方から使う）
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ApiError } from "./api/client.ts";
import type { createAppRouter } from "./router.tsx";
import { rawStorage } from "./state/storage.ts";

const DAY = 24 * 60 * 60 * 1000;

/** 前回の画面を即座に描くために永続化するクエリ（13.5。会話は直近 100 件） */
const PERSISTED = new Set(["instructions", "threads", "messages", "sidebar"]);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: DAY,
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

type Props = { queryClient: QueryClient; router: ReturnType<typeof createAppRouter>; persist: boolean };

export function App({ queryClient, router, persist }: Props) {
  if (!persist) {
    return (
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  }
  const persister = createSyncStoragePersister({
    storage: { getItem: (k) => rawStorage.getItem(k) as string | null, setItem: (k, v) => void rawStorage.setItem(k, v), removeItem: (k) => void rawStorage.removeItem(k) },
    key: "baton-query-cache",
  });
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: DAY,
        buster: "v2",
        dehydrateOptions: { shouldDehydrateQuery: (q) => PERSISTED.has(String(q.queryKey[0])) && q.state.status === "success" },
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  );
}
