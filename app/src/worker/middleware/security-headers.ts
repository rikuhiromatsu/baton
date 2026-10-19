// セキュリティヘッダ（設計書 6.6）
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.ts";

export function contentSecurityPolicy(env: { BATON_ENV: string }): string {
  const connect = ["'self'", "wss://baton.rikuhiromatsu.workers.dev", "https://*.ts.net"];
  if (env.BATON_ENV !== "production") connect.push("ws://localhost:8790");
  return [
    "default-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data: https://lh3.googleusercontent.com",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.res.status === 101) return; // WebSocket の応答はそのまま返す
  const set = (k: string, v: string) => {
    try {
      c.res.headers.set(k, v);
    } catch {
      // 不変のヘッダ（DO から来た応答など）は作り直す
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set(k, v);
    }
  };
  set("Content-Security-Policy", contentSecurityPolicy(c.env));
  set("X-Content-Type-Options", "nosniff");
  set("Referrer-Policy", "same-origin");
  if (c.env.BATON_ENV === "production") set("Strict-Transport-Security", "max-age=31536000");
  if (c.req.path.startsWith("/api/")) set("Cache-Control", "no-store");
};
