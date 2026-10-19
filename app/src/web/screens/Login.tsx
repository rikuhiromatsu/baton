// ログイン（7.2）。ガラスのカード 1 枚、Baton のマーク、「Google でログイン」だけ
import { useEffect } from "react";
import { motion } from "motion/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { TESTIDS, UI_TEXT } from "@baton/shared";
import { api } from "../api/client.ts";
import { qk } from "../api/keys.ts";
import { adoptBootComposerIntoDraft } from "../components/Composer.tsx";
import { BatonMark, IconGoogle } from "../components/Icons.tsx";
import { dismissBootSkeleton } from "../lib/boot.ts";
import { getMockHooks, isMockMode } from "../lib/env.ts";
import { spring } from "../motion/tokens.ts";

function safeRedirect(r: unknown): string {
  return typeof r === "string" && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/login") ? r : "/";
}

export function Login() {
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const redirect = safeRedirect(search.redirect);
  const error = search.e === undefined ? null : String(search.e) === "forbidden" ? UI_TEXT.loginForbidden : UI_TEXT.loginFailed;

  useEffect(() => {
    // 未ログインで打った文字は下書きへ（ログイン後に戻す）
    adoptBootComposerIntoDraft();
    dismissBootSkeleton();
  }, []);

  const login = () => {
    if (isMockMode()) {
      getMockHooks().login?.();
      void qc.invalidateQueries({ queryKey: qk.session });
      void navigate({ to: redirect });
      return;
    }
    location.href = api.loginUrl(redirect);
  };

  return (
    <main className="screen screen--login">
      <motion.div className="login glass glass--sheet" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring.gentle}>
        <div className="login__mark">
          <BatonMark size={64} />
        </div>
        <div className="login__name">Baton</div>
        {error && (
          <p className="login__error" data-testid={TESTIDS.loginError} role="alert">
            {error}
          </p>
        )}
        <motion.button type="button" className="google-button" data-testid={TESTIDS.loginGoogle} onClick={login} whileTap={{ scale: 0.97 }} transition={spring.snappy}>
          <IconGoogle />
          <span>{UI_TEXT.loginGoogle}</span>
        </motion.button>
      </motion.div>
    </main>
  );
}
