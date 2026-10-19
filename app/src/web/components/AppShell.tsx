// 一番外側（v1 7.5）: 背景・ログインの行き来・WebSocket と presence・トースト・初回の案内
import { useEffect } from "react";
import { MotionConfig } from "motion/react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client.ts";
import { flushOutbox } from "../api/messages.ts";
import { useSession } from "../api/queries.ts";
import { Realtime, getSocketFactory, setRealtime } from "../api/ws.ts";
import { probeTailnet } from "../lib/tailnet.ts";
import { useUi } from "../state/ui.ts";
import { AmbientBackground } from "./AmbientBackground.tsx";
import { Onboarding, useAutoOnboarding } from "./Onboarding.tsx";
import { ToastHost } from "./Overlays.tsx";

export function AppShell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isLogin = pathname === "/login";
  const session = useSession();
  const loggedIn = session.data !== undefined && !session.isError;
  useAutoOnboarding(loggedIn && !isLogin);
  // 案内を開いている間は、裏の画面をキーボードでも触れなくする
  const onboardingOpen = useUi((s) => s.onboardingOpen);

  // 未ログインはログイン画面へ（v1 7.2 の 401）
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

  // オフラインで開いたとき: TanStack Query の onlineManager はオンラインのつもりで始まるので、取得はネットワークの失敗で終わり、
  // つながっても取り直さない。つながったら失敗したもの（セッションを含む）を取り直す。セッションがそろえば下の処理で送信待ちを送る
  useEffect(() => {
    const onOnline = () => void qc.refetchQueries({ predicate: (q) => q.state.status === "error" });
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [qc]);

  // WebSocket（ログイン中だけ）と、画面が見えているか（見えている間は通知を送らない。10.2・D-88）
  useEffect(() => {
    if (!loggedIn) return;
    const rt = new Realtime({ qc, createSocket: getSocketFactory() });
    setRealtime(rt);
    rt.start();
    void flushOutbox(qc);
    let focused = typeof document === "undefined" || document.hasFocus?.() !== false;
    const visible = () => document.visibilityState !== "hidden" && focused;
    rt.setPresence(visible());
    const onOnline = () => {
      rt.nudge();
      void flushOutbox(qc);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") rt.nudge();
      rt.setPresence(visible());
    };
    const onFocus = () => {
      focused = true;
      rt.setPresence(visible());
    };
    const onBlur = () => {
      focused = false;
      rt.setPresence(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
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

  return (
    <MotionConfig reducedMotion="user">
      <AmbientBackground />
      <div className="app-layer" inert={onboardingOpen}>
        <Outlet />
        <ToastHost />
      </div>
      {!isLogin && <Onboarding />}
    </MotionConfig>
  );
}
