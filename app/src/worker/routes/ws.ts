// WebSocket を Hub（DO）へ渡す（設計書 4.2・4.3・6.3）
import type { Context } from "hono";
import { SOCKET_KIND_HEADER, SOCKET_RUNNER_HEADER } from "../hub/batonhub.ts";
import { hubStub } from "../hub/broadcast.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../types.ts";

export async function forwardToHub(c: Context<AppEnv>, kind: "browser" | "runner", runnerId?: string): Promise<Response> {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new ApiError("invalid", "websocket upgrade required");
  const headers = new Headers({ Upgrade: "websocket", [SOCKET_KIND_HEADER]: kind });
  if (runnerId) headers.set(SOCKET_RUNNER_HEADER, runnerId);
  return hubStub(c.env).fetch(new Request("https://hub/ws", { headers }));
}
