// 画面のルート（7.2）。コードで定義する
import { createRootRouteWithContext, createRoute, createRouter, retainSearchParams, type RouterHistory } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell.tsx";
import { Archive } from "./screens/Archive.tsx";
import { Home } from "./screens/Home.tsx";
import { Login } from "./screens/Login.tsx";
import { Projects } from "./screens/Projects.tsx";

type RouterContext = { queryClient: QueryClient };
type RootSearch = { mock?: number };
type LoginSearch = { redirect?: string; e?: string };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  // 数値で持つ（文字列だと ?mock=%221%22 のように引用符付きで書き出されるため）
  validateSearch: (s: Record<string, unknown>): RootSearch => (Number(s.mock) === 1 ? { mock: 1 } : {}),
  // ?mock=1 を画面遷移のあとも残す（再読み込みしてもモックのまま）
  search: { middlewares: [retainSearchParams<RootSearch>(["mock"])] },
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

const homeRoute = createRoute({ getParentRoute: () => rootRoute, id: "home", component: Home });
const homeIndexRoute = createRoute({ getParentRoute: () => homeRoute, path: "/", component: () => null });
const instructionRoute = createRoute({ getParentRoute: () => homeRoute, path: "i/$id", component: () => null });
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "projects", component: Projects });
const archiveRoute = createRoute({ getParentRoute: () => rootRoute, path: "archive", component: Archive });

export const routeTree = rootRoute.addChildren([loginRoute, homeRoute.addChildren([homeIndexRoute, instructionRoute]), projectsRoute, archiveRoute]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history, defaultPreload: false, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
