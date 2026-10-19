import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * `vite build --mode e2e` と同じく、Worker のソースの import.meta.env.MODE を "e2e" に置き換える。
 * Vitest は mode を常に "test" にするため（CLI の --mode 以外では変えられない）。
 * これでテスト用ルート（設計書 6.5 の条件 1）がテストのビルドに含まれる。
 */
function e2eBuildMode(): Plugin {
  return {
    name: "baton-e2e-build-mode",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/src/worker/") || !code.includes("import.meta.env.MODE")) return null;
      return { code: code.replaceAll("import.meta.env.MODE", JSON.stringify("e2e")), map: null };
    },
  };
}

// Workers 統合テスト（v1 設計書 8.3、DESIGN-v2 15.3 の W1〜W6・W8〜W13・W15〜W36・W40〜W45）。本物の workerd 上で D1・DO・Worker を動かす
export default defineConfig({
  plugins: [
    e2eBuildMode(),
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      // W17 用: wrangler.jsonc の assets 設定（コメントを落として読む）
      const wranglerText = readFileSync(path.join(import.meta.dirname, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
      const assetsConfig = JSON.stringify((JSON.parse(wranglerText) as { assets?: unknown }).assets ?? null);
      return {
        wrangler: { configPath: "./wrangler.jsonc", environment: "e2e" },
        miniflare: {
          // .dev.vars.e2e は git 管理外なので、CI でも同じ値になるようここで与える
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_ASSETS_CONFIG: assetsConfig,
            E2E_TEST_SECRET: "e2e-local-secret",
            ALLOWED_EMAILS: "ceo@example.com, Second@Example.com",
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            // Web Push のテスト用の鍵（.dev.vars.e2e.example と同じ。本番には登録しない）
            VAPID_PUBLIC_KEY: "BKtph3lHgfzgmSw96CXfaU3s_8bQtdxKZiV4gEgCPAIdVUPMlyStfa0-EctLKcS5O8dKxHeUt5GlCwnrGep7ld8",
            VAPID_PRIVATE_KEY: "nw7OIm-PeVRjO-GAWwpuOesTi1gYIsIcoKlsXZScOdc",
            BATON_PUSH_BATCH_MS: "300",
            BATON_CONVERSATION_BREAK_MS: "60000",
          },
        },
      };
    }),
  ],
  test: {
    name: "worker",
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/worker/setup.ts"],
    testTimeout: 20_000,
  },
});
