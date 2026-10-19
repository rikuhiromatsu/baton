// Worker の入口（v1 設計書 4・6・9.1、DESIGN-v2 12 章）。Hono のアプリと Durable Object の export
import { Hono } from "hono";
import { TEST_SECRET_HEADER } from "@baton/shared";
import { botHttpRoutes } from "./bot/http.ts";
import { errorBody } from "./lib/errors.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { requireSession } from "./middleware/auth.ts";
import { requireCsrf, requireSameOrigin } from "./middleware/csrf.ts";
import { onError, onNotFound } from "./middleware/errors.ts";
import { requireRunner } from "./middleware/runner-auth.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { artifactRoutes } from "./routes/artifacts.ts";
import { authRoutes } from "./routes/auth.ts";
import { botTokenRoutes } from "./routes/bot-tokens.ts";
import { decisionRoutes } from "./routes/decisions.ts";
import { instructionRoutes } from "./routes/instructions.ts";
import { orgRoutes, profileRoutes, projectRoutes, quotaRoutes, repoRoutes } from "./routes/org.ts";
import { proposalRoutes } from "./routes/proposals.ts";
import { pushRoutes } from "./routes/push.ts";
import { runnerControlRoutes } from "./routes/runner/control.ts";
import { runnerInstructionRoutes } from "./routes/runner/instructions.ts";
import { runnerSessionRoutes } from "./routes/runner/sessions.ts";
import { runnerThreadRoutes } from "./routes/runner/threads.ts";
import { sessionInfoRoutes } from "./routes/session.ts";
import { sessionRoutes, transcriptItemRoutes } from "./routes/sessions.ts";
import { testRoutesAllowed } from "./routes/test-gate.ts";
import { threadRoutes } from "./routes/threads.ts";
import { transitionRoutes } from "./routes/transitions.ts";
import { forwardToHub } from "./routes/ws.ts";
import type { AppEnv } from "./types.ts";

export { BatonHub } from "./hub/batonhub.ts";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.onError(onError);
app.notFound(onNotFound);

/**
 * 無い /api/* は認証より前に 404（消した経路も 401 ではなく 404。本番スモークが確かめる。15.4）。
 * 登録済みのルート（method＋path）から判定する（use の中間処理は数えない）
 */
let knownRoutes: { method: string; re: RegExp }[] | null = null;
function routeExists(method: string, path: string): boolean {
  knownRoutes ??= app.routes
    .filter((r) => r.method !== "ALL" || r.path.startsWith("/api/test/"))
    .map((r) => ({
      method: r.method,
      re: new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/\*$/, "(/.*)?").replace(/\*/g, ".*").replace(/:[A-Za-z0-9_]+/g, "[^/]+")}/?$`),
    }));
  const m = method === "HEAD" ? "GET" : method;
  return knownRoutes.some((r) => (r.method === "ALL" || r.method === m) && r.re.test(path));
}
app.use("/api/*", async (c, next) => {
  if (!routeExists(c.req.method, c.req.path)) return onNotFound(c);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.BATON_ENV }));

// ───────────── ブラウザ用（Cookie セッション＋CSRF） ─────────────
app.route("/api/auth", authRoutes);
app.route("/api/session", sessionInfoRoutes);

const browserRoutes = {
  threads: threadRoutes,
  "project-proposals": proposalRoutes,
  instructions: instructionRoutes,
  transitions: transitionRoutes,
  decisions: decisionRoutes,
  sessions: sessionRoutes,
  "transcript-items": transcriptItemRoutes,
  artifacts: artifactRoutes,
  org: orgRoutes,
  projects: projectRoutes,
  repos: repoRoutes,
  profiles: profileRoutes,
  quota: quotaRoutes,
  push: pushRoutes,
  "bot-tokens": botTokenRoutes,
} as const;
for (const [prefix, routes] of Object.entries(browserRoutes)) {
  app.use(`/api/${prefix}`, requireSession, requireCsrf);
  app.use(`/api/${prefix}/*`, requireSession, requireCsrf);
  app.route(`/api/${prefix}`, routes);
}
app.get("/api/ws", requireSameOrigin, requireSession, (c) => forwardToHub(c, "browser"));

// ───────────── ランナー用（Bearer のランナートークン） ─────────────
const runner = new Hono<AppEnv>();
runner.use("*", requireRunner);
runner.route("/", runnerControlRoutes);
runner.route("/", runnerThreadRoutes);
runner.route("/", runnerInstructionRoutes);
runner.route("/", runnerSessionRoutes);
app.route("/api/runner", runner);

// ───────────── 秘書 bot 用（Bearer の bot トークン。Cookie を見ない・CSRF の対象外・CORS なし） ─────────────
app.route("/mcp", mcpRoutes);
app.route("/api/bot/v1", botHttpRoutes);

// ───────────── e2e 専用（v1 設計書 6.5。本番ビルドではこの if ごと消える） ─────────────
if (import.meta.env.MODE === "e2e") {
  app.all("/api/test/*", async (c) => {
    if (!testRoutesAllowed(import.meta.env.MODE, c.env, c.req.url, c.req.header(TEST_SECRET_HEADER))) {
      return c.json(errorBody("not_found", "not found"), 404);
    }
    const { testOnlyRoutes } = await import("./routes/test-only.ts");
    testOnlyRoutes.onError(onError);
    testOnlyRoutes.notFound(onNotFound);
    return testOnlyRoutes.fetch(c.req.raw, c.env);
  });
}

export default app;
