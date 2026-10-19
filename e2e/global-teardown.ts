// E2E の後片付け: ランナーを止め、一時フォルダ（作業フォルダ・sample-repo・偽 claude の状態）を消す。webServer は Playwright が止める
import fs from "node:fs";
import { readRunnerState, stopRunner } from "./helpers/runner.ts";

export default async function globalTeardown(): Promise<void> {
  const state = readRunnerState();
  await stopRunner();
  if (state?.rootDir && !process.env.BATON_E2E_KEEP_DATA) {
    fs.rmSync(state.rootDir, { recursive: true, force: true });
  }
}
