import { Hono } from "hono";
import type { Env } from "./env.ts";

export { BatonHub } from "./hub/batonhub.ts";

// U1 が実装する。いまは土台の確認用
const app = new Hono<{ Bindings: Env }>();
app.get("/api/health", (c) => c.json({ ok: true, env: c.env.BATON_ENV }));
app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "not found" } }, 404));

export default app;
