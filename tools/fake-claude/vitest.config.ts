import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "fake-claude", root: import.meta.dirname, include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
