// アプリの組み立て（main とテストの両方から使う）
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { ApiError } from "./api/client.ts";
import type { createAppRouter } from "./router.tsx";
import { rawStorage } from "./state/storage.ts";

const DAY = 24 * 60 * 60 * 1000;

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
  // 前回の一覧を localStorage から即座に描く（24 時間。7.4 の 3）
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
        buster: "v1",
        dehydrateOptions: { shouldDehydrateQuery: (q) => q.queryKey[0] === "instructions" && q.state.status === "success" },
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  );
}
