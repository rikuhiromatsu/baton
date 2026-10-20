// R33 ログの伏せ字: 鍵・トークンは伏せ、出どころの名前（apiKeySource・keySource）は残す（init の検査 7.7 をログで確かめる）
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";

describe("R33 ログの伏せ字", () => {
  it("typesafeApiKey・token は伏せ、apiKeySource・keySource は残す", () => {
    const lines: string[] = [];
    createLogger({ write: (l) => lines.push(l) }).info("x", { typesafeApiKey: "k", runnerToken: "t", apiKeySource: "none", keySource: "settings" });
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({ typesafeApiKey: "[redacted]", runnerToken: "[redacted]", apiKeySource: "none", keySource: "settings" });
  });
});
