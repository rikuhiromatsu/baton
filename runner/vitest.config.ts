import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "runner", root: import.meta.dirname, include: ["test/**/*.test.ts"], environment: "node", testTimeout: 20_000 },
});
