/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../../src/worker/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** wrangler.jsonc の assets（JSON 文字列） */
      TEST_ASSETS_CONFIG: string;
      /** W26 用の空の D1 */
      MIGRATION_DB: D1Database;
    }
  }
}
