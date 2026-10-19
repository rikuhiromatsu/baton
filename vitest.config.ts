import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared/vitest.config.ts",
      "app/vitest.web.config.ts",
      "runner/vitest.config.ts",
      "tools/fake-claude/vitest.config.ts",
    ],
  },
});
