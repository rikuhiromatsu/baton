import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Workers 統合テスト（設計書 8.3 W1〜W17）。本物の workerd 上で D1・DO・Worker を動かす
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "e2e" },
    }),
  ],
  test: {
    name: "worker",
    include: ["test/worker/**/*.test.ts"],
  },
});
