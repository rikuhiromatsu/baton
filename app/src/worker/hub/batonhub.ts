import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

// リアルタイム配信の Durable Object（設計書 4.5）。U1 が実装する
export class BatonHub extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
