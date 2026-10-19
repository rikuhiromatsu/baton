import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// 画面（SPA・PWA）と Worker を 1 つの Vite プロジェクトで扱う（設計書 2.1）
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // e2e は専用の保存先を使い、毎回まっさらな D1 で始める（前回の使用量や指示に左右されないため）
    cloudflare({ persistState: mode === "e2e" ? { path: ".wrangler/state-e2e" } : true }),
    VitePWA({
      // push の受け取りと通知のタップを自前の Service Worker（src/web/sw.ts）で扱う（設計書 v2 10.4）
      strategies: "injectManifest",
      srcDir: "src/web",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "Baton",
        short_name: "Baton",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#FFFFFF",
        theme_color: "#FFFFFF",
        orientation: "portrait",
        lang: "ja",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  define: {
    __BATON_BUILD_MODE__: JSON.stringify(mode),
  },
  build: { sourcemap: mode !== "production" },
}));
