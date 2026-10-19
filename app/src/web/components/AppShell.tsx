// 背景・上部バー・ルートの出口・入力欄・トースト（7.5）
import { useEffect } from "react";
import { MotionConfig } from "motion/react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { UI_TEXT } from "@baton/shared";
import { flushOutbox } from "../api/actions.ts";
import { ApiError } from "../api/client.ts";
import { useSession, useUsage } from "../api/queries.ts";
import { Realtime, getSocketFactory, setRealtime } from "../api/ws.ts";
import { probeTailnet } from "../lib/tailnet.ts";
import { useUi } from "../state/ui.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { Onboarding, useAutoOnboarding } from "./Onboarding.tsx";
import { AmbientBackground } from "./AmbientBackground.tsx";
import { Composer } from "./Composer.tsx";
import { SendBackSheet } from "./SendBackSheet.tsx";
import { TopBar } from "./TopBar.tsx";
import { ToastHost } from "./UndoToast.tsx";

export function AppShell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isLogin = pathname === "/login";
  const session = useSession();
  const loggedIn = session.data !== undefined && !session.isError;
  const usage = useUsage(loggedIn);
  useAutoOnboarding(loggedIn && !isLogin);
  // 案内を開いている間は、裏の画面をキーボードでも触れなくする（Codex の指摘）
  const onboardingOpen = useUi((s) => s.onboardingOpen);

  // 未ログインはログイン画面へ（7.2 の 401）
  useEffect(() => {
    if (isLogin) return;
    if (session.error instanceof ApiError && session.error.status === 401) {
      void navigate({ to: "/login", search: { redirect: pathname }, replace: true });
    }
  }, [isLogin, navigate, pathname, session.error]);

  // ログイン済みでログイン画面にいたら戻す
  useEffect(() => {
    if (!isLogin || !loggedIn) return;
    const redirect = new URLSearchParams(location.search).get("redirect");
    const to = redirect && redirect.startsWith("/") && !redirect.startsWith("//") && !redirect.startsWith("/login") ? redirect : "/";
    void navigate({ to, replace: true });
  }, [isLogin, loggedIn, navigate]);

  // WebSocket（ログイン中だけ）
  useEffect(() => {
    if (!loggedIn) return;
    const rt = new Realtime({ qc, createSocket: getSocketFactory() });
    setRealtime(rt);
    rt.start();
    void flushOutbox(qc);
    const onOnline = () => {
      rt.nudge();
      void flushOutbox(qc);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") rt.nudge();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      rt.stop();
      setRealtime(null);
    };
  }, [loggedIn, qc]);

  // tailnet 直結を 1.5 秒で試す
  const tailnetUrl = session.data?.runner.tailnetUrl ?? null;
  useEffect(() => {
    if (loggedIn) void probeTailnet(tailnetUrl);
  }, [loggedIn, tailnetUrl]);

  const back = pathname === "/projects" ? { title: UI_TEXT.menuProjects } : pathname === "/archive" ? { title: UI_TEXT.menuArchive } : null;

  return (
    <MotionConfig reducedMotion="user">
      <AmbientBackground />
      <div className="app-layer" inert={onboardingOpen}>
        <div className="app">
          {!isLogin && <TopBar session={session.data} usage={usage.data} back={back} />}
          <Outlet />
        </div>
        {!isLogin && <Composer />}
        <ToastHost />
        <ActionMenu />
        <SendBackSheet />
      </div>
      {!isLogin && <Onboarding />}
    </MotionConfig>
  );
}
