// E2E の後片付け: ランナーを止める（webServer は Playwright が止める）
import fs from "node:fs";
import { readRunnerState, stopRunner } from "./helpers/runner.ts";

export default async function globalTeardown(): Promise<void> {
  const state = readRunnerState();
  await stopRunner();
  if (state && !process.env.BATON_E2E_KEEP_DATA) {
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  }
}
