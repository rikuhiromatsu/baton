import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    root: import.meta.dirname,
    include: ["test/web/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["test/web/setup.ts"],
  },
});
