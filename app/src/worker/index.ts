// Worker の入口（設計書 4・6・9.1）。Hono のアプリと Durable Object の export
import { Hono } from "hono";
import { TEST_SECRET_HEADER } from "@baton/shared";
import { errorBody } from "./lib/errors.ts";
import { requireSession } from "./middleware/auth.ts";
import { requireCsrf, requireSameOrigin } from "./middleware/csrf.ts";
import { onError, onNotFound } from "./middleware/errors.ts";
import { requireRunner } from "./middleware/runner-auth.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { artifactRoutes } from "./routes/artifacts.ts";
import { authRoutes } from "./routes/auth.ts";
import { decisionRoutes } from "./routes/decisions.ts";
import { instructionRoutes } from "./routes/instructions.ts";
import { projectRoutes } from "./routes/projects.ts";
import { runnerAiRoutes } from "./routes/runner/ai.ts";
import { runnerControlRoutes } from "./routes/runner/control.ts";
import { runnerWorkRoutes } from "./routes/runner/work.ts";
import { sessionRoutes } from "./routes/session.ts";
import { testRoutesAllowed } from "./routes/test-gate.ts";
import { transitionRoutes } from "./routes/transitions.ts";
import { usageRoutes } from "./routes/usage.ts";
import { forwardToHub } from "./routes/ws.ts";
import type { AppEnv } from "./types.ts";

export { BatonHub } from "./hub/batonhub.ts";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
app.onError(onError);
app.notFound(onNotFound);

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.BATON_ENV }));

// ───────────── ブラウザ用（Cookie セッション） ─────────────
app.route("/api/auth", authRoutes);
app.route("/api/session", sessionRoutes);

const browserRoutes = {
  instructions: instructionRoutes,
  transitions: transitionRoutes,
  decisions: decisionRoutes,
  projects: projectRoutes,
  artifacts: artifactRoutes,
  usage: usageRoutes,
} as const;
for (const [prefix, routes] of Object.entries(browserRoutes)) {
  app.use(`/api/${prefix}`, requireSession, requireCsrf);
  app.use(`/api/${prefix}/*`, requireSession, requireCsrf);
  app.route(`/api/${prefix}`, routes);
}
app.get("/api/ws", requireSameOrigin, requireSession, (c) => forwardToHub(c, "browser"));

// ───────────── ランナー用（Bearer） ─────────────
const runner = new Hono<AppEnv>();
runner.use("*", requireRunner);
runner.route("/ai", runnerAiRoutes);
runner.route("/", runnerControlRoutes);
runner.route("/", runnerWorkRoutes);
app.route("/api/runner", runner);

// ───────────── e2e 専用（設計書 6.5。本番ビルドではこの if ごと消える） ─────────────
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
