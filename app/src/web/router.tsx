// 画面のルート（13.2）。中身は MainLayout がパスから描き分ける（モバイルで COO の会話の上に重ねるため）
import { createRootRouteWithContext, createRoute, createRouter, retainSearchParams, type RouterHistory } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell.tsx";
import { MainLayout } from "./components/MainLayout.tsx";
import { Login } from "./screens/Login.tsx";

type RouterContext = { queryClient: QueryClient };
type RootSearch = { mock?: number; still?: number; scenario?: string };
type LoginSearch = { redirect?: string; e?: string };
export type DetailSearch = { s?: string };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  // 数値で持つ（文字列だと ?mock=%221%22 のように引用符付きで書き出されるため）
  validateSearch: (s: Record<string, unknown>): RootSearch => ({
    ...(Number(s.mock) === 1 ? { mock: 1 } : {}),
    ...(Number(s.still) === 1 ? { still: 1 } : {}),
    ...(s.scenario === "a" ? { scenario: "a" } : {}),
  }),
  // ?mock=1 を画面遷移のあとも残す（再読み込みしてもモックのまま）
  search: { middlewares: [retainSearchParams<RootSearch>(["mock", "still"])] },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  validateSearch: (s: Record<string, unknown>): LoginSearch => ({
    ...(typeof s.redirect === "string" ? { redirect: s.redirect } : {}),
    ...(s.e !== undefined ? { e: String(s.e) } : {}),
  }),
  component: Login,
});

const mainRoute = createRoute({ getParentRoute: () => rootRoute, id: "main", component: MainLayout });
const empty = () => null;
const homeRoute = createRoute({ getParentRoute: () => mainRoute, path: "/", component: empty });
const projectRoute = createRoute({ getParentRoute: () => mainRoute, path: "p/$projectId", component: empty });
const leaderRoute = createRoute({ getParentRoute: () => mainRoute, path: "p/$projectId/leader", component: empty });
const instructionRoute = createRoute({
  getParentRoute: () => mainRoute,
  path: "i/$id",
  validateSearch: (s: Record<string, unknown>): DetailSearch => (typeof s.s === "string" && s.s ? { s: s.s } : {}),
  component: empty,
});
const orgRoute = createRoute({ getParentRoute: () => mainRoute, path: "org", component: empty });
const settingsRoute = createRoute({ getParentRoute: () => mainRoute, path: "settings", component: empty });
const archiveRoute = createRoute({ getParentRoute: () => mainRoute, path: "archive", component: empty });

export const routeTree = rootRoute.addChildren([
  loginRoute,
  mainRoute.addChildren([homeRoute, projectRoute, leaderRoute, instructionRoute, orgRoute, settingsRoute, archiveRoute]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history, defaultPreload: false, scrollRestoration: false });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
