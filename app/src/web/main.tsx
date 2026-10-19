// 起動（v1 7.4・DESIGN-v2 13.5）。?mock=1 のときだけモックを動的に読み込む
import "./lib/zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createQueryClient } from "./App.tsx";
import { setSessionLoader, setTransport, setUnauthorizedHandler } from "./api/client.ts";
import { qk } from "./api/keys.ts";
import { fetchSession } from "./api/queries.ts";
import { setSocketFactory } from "./api/ws.ts";
import { registerMockHooks, setMockMode } from "./lib/env.ts";
import { setPushDriver } from "./lib/push.ts";
import { setTailnetDriver } from "./lib/tailnet.ts";
import { applyTheme, readThemePref } from "./lib/theme.ts";
import { createAppRouter } from "./router.tsx";
import { useDraft } from "./state/draft.ts";
import { useOutbox } from "./state/outbox.ts";
import "./styles/app.css";

async function boot() {
  const params = new URLSearchParams(location.search);
  const mock = params.get("mock") === "1";
  setMockMode(mock);
  // インラインのスクリプトが付けた data-theme と theme-color をそろえる（13.11）
  applyTheme(readThemePref());
  if (mock) {
    const { createMock, mockRawLog } = await import("./api/mock.ts");
    const handle = createMock({
      loggedOut: params.get("auth") === "0",
      empty: params.get("empty") === "1",
      listDelayMs: Number(params.get("listDelay") ?? 0) || 0,
      scenario: params.get("scenario") === "a" ? "a" : null,
      still: params.get("still") === "1",
      speed: Number(params.get("speed") ?? 1) || 1,
    });
    const backend = handle.backend;
    setTransport(backend.fetch);
    setSocketFactory(backend.createSocket);
    setTailnetDriver({ fetch: async () => new Response("{}", { status: 200 }), openRawLog: mockRawLog });
    // モックでは通知の許可と購読をまねる（本物のプッシュサービスにはつながない）
    setPushDriver({
      support: () => "supported",
      permission: () => "granted",
      requestPermission: async () => "granted",
      subscribe: async () => ({ endpoint: "https://web.push.apple.com/mock-device", keys: { p256dh: "mock-p256dh", auth: "mock-auth" } }),
      current: async () => null,
      unsubscribe: async () => {},
    });
    registerMockHooks({ login: () => backend.login() });
    (window as unknown as { __batonMock?: unknown }).__batonMock = handle;
  }
  await Promise.all([useDraft.persist.rehydrate(), useOutbox.persist.rehydrate()]);

  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient);
  setSessionLoader(() => queryClient.fetchQuery({ queryKey: qk.session, queryFn: ({ signal }) => fetchSession(signal) }));
  setUnauthorizedHandler(() => {
    const path = router.state.location.pathname;
    if (path === "/login") return;
    // ログアウト状態の端末に前の会話を残さない
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    void router.navigate({ to: "/login", search: { redirect: path }, replace: true });
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App queryClient={queryClient} router={router} persist={!mock} />
    </StrictMode>,
  );

  if (!mock && import.meta.env.PROD) {
    // 更新があれば次回起動時に入れ替える（告知は出さない。v1 7.10）
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({ immediate: true });
  }
}

void boot();
