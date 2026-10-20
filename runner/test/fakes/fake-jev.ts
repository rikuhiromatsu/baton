// 偽の Jev（15.3）。ctx.jev に差し込む。応答を台本で返し、呼ばれた state を記録する。TypeSafe は呼ばない。
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JevClient, JevResult, JevStatus } from "../../src/claude/jev.ts";

export type FakeJevScript = {
  tier?: "fast" | "balanced" | "deep";
  confidence?: number | null;
  /** 0..3 */
  effort?: number | null;
  effortConfidence?: number | null;
  risky?: number | null;
  delayMs?: number;
  fail?: "timeout" | "http500" | "badjson" | "throw";
};

export class FakeJev implements JevClient {
  calls: Record<string, unknown>[] = [];
  script: FakeJevScript;
  constructor(script: FakeJevScript = {}) {
    this.script = script;
  }

  async decide(state: Record<string, unknown>): Promise<JevResult> {
    this.calls.push(state);
    const s = this.script;
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.fail === "throw") throw new Error("fake jev: throw");
    if (s.fail === "timeout") return { decision: null, ms: s.delayMs ?? 0, error: "timeout" };
    if (s.fail === "http500") return { decision: null, ms: 1, error: "http 500" };
    if (s.fail === "badjson") return { decision: null, ms: 1, error: "bad_body" };
    return {
      decision: {
        tier: s.tier ?? "balanced",
        confidence: s.confidence === undefined ? 0.9 : s.confidence,
        effort: s.effort === undefined ? 1 : s.effort,
        effortConfidence: s.effortConfidence === undefined ? 0.9 : s.effortConfidence,
        risky: s.risky === undefined ? 0.05 : s.risky,
      },
      ms: s.delayMs ?? 5,
      error: null,
    };
  }

  status(): JevStatus {
    return { keySource: "env", lastAt: null, lastError: null };
  }
}

export type Launch = { name: string; model: string; effort: string; resume: string; sessionId: string };

/** 偽 claude の前に挟み、起動のたびに --model・--effort・--resume・--session-id・--name を 1 行ずつ記録する */
export async function makeClaudeSpy(dir: string, realBin: string): Promise<{ bin: string; launches: () => Promise<Launch[]> }> {
  const bin = path.join(dir, "claude-spy.sh");
  const log = path.join(dir, "claude-launches.log");
  await writeFile(
    bin,
    `#!/bin/sh
if [ "$1" = "-p" ]; then
  prev=""; m=""; e=""; r=""; s=""; n=""
  for a in "$@"; do
    case "$prev" in
      --model) m="$a" ;;
      --effort) e="$a" ;;
      --resume) r="$a" ;;
      --session-id) s="$a" ;;
      --name) n="$a" ;;
    esac
    prev="$a"
  done
  printf '%s|%s|%s|%s|%s\\n' "$n" "$m" "$e" "$r" "$s" >> '${log}'
fi
exec '${realBin}' "$@"
`,
  );
  await chmod(bin, 0o755);
  const { readFile } = await import("node:fs/promises");
  return {
    bin,
    launches: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [name = "", model = "", effort = "", resume = "", sessionId = ""] = l.split("|");
          return { name, model, effort, resume, sessionId };
        }),
  };
}
