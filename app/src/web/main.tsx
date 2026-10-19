// 起動（7.4）。?mock=1 のときだけモックを動的に読み込む
import "./lib/zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createQueryClient } from "./App.tsx";
import { setSessionLoader, setTransport, setUnauthorizedHandler } from "./api/client.ts";
import { qk } from "./api/keys.ts";
import { fetchSession } from "./api/queries.ts";
import { setSocketFactory } from "./api/ws.ts";
import { registerMockHooks, setMockMode } from "./lib/env.ts";
import { setTailnetDriver } from "./lib/tailnet.ts";
import { createAppRouter } from "./router.tsx";
import { useDraft } from "./state/draft.ts";
import { useOutbox } from "./state/outbox.ts";
import "./styles/app.css";

async function boot() {
  const params = new URLSearchParams(location.search);
  const mock = params.get("mock") === "1";
  setMockMode(mock);
  if (mock) {
    const { MockBackend, mockRawLog } = await import("./api/mock.ts");
    const backend = new MockBackend({
      loggedOut: params.get("auth") === "0",
      empty: params.get("empty") === "1",
      listDelayMs: Number(params.get("listDelay") ?? 0) || 0,
    });
    setTransport(backend.fetch);
    setSocketFactory(backend.createSocket);
    setTailnetDriver({ fetch: async () => new Response("{}", { status: 200 }), openRawLog: mockRawLog });
    registerMockHooks({ login: () => backend.login() });
    (window as unknown as { __batonMock?: unknown }).__batonMock = backend;
  }
  await Promise.all([useDraft.persist.rehydrate(), useOutbox.persist.rehydrate()]);

  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient);
  setSessionLoader(() => queryClient.fetchQuery({ queryKey: qk.session, queryFn: ({ signal }) => fetchSession(signal) }));
  setUnauthorizedHandler(() => {
    const path = router.state.location.pathname;
    if (path === "/login") return;
    // ログアウト状態の端末に前の一覧を残さない
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    void router.navigate({ to: "/login", search: { redirect: path }, replace: true });
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App queryClient={queryClient} router={router} persist={!mock} />
    </StrictMode>,
  );

  if (!mock && import.meta.env.PROD) {
    // 更新があれば次回起動時に入れ替える（告知は出さない。7.10）
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({ immediate: true });
  }
}

void boot();
