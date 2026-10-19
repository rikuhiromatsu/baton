// テストの共通部品: 偽 claude を本物と同じように子プロセスで起動し、出力の全行を shared の検査に通す。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { encodeStdin, normalizeStreamLines, parseStreamLine, type StdinMessage } from "@baton/shared";

export const BIN = path.resolve(import.meta.dirname, "../bin/claude");

export function tempDir(prefix = "fake-claude-test-"): { dir: string; cleanup: () => void } {
  // macOS の /var は /private/var へのリンク。cwd（realpath）と許可ルールのパスをそろえる
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** ランナーと同じく process.env を引き継がない環境（7.7） */
export function cleanEnv(stateDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "ja_JP.UTF-8",
    FAKE_CLAUDE_STATE_DIR: stateDir,
    FAKE_CLAUDE_STEP_MS: "0",
    FAKE_CLAUDE_DELTA_MS: "0",
    ...extra,
  };
}

export type Line = Record<string, unknown> & { type: string };

export class FakeProc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly raw: string[] = [];
  stderr = "";
  private buf = "";
  private waiters: (() => void)[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(BIN, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.raw.push(line);
      }
      for (const w of this.waiters.splice(0)) w();
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      this.stderr += d;
    });
    this.exited = new Promise((resolve) => {
      this.child.on("close", (code, signal) => {
        for (const w of this.waiters.splice(0)) w();
        resolve({ code, signal });
      });
    });
  }

  get lines(): Line[] {
    return this.raw.map((l) => JSON.parse(l) as Line);
  }

  send(msg: StdinMessage | Record<string, unknown>): void {
    this.child.stdin.write(encodeStdin(msg as StdinMessage));
  }

  close(): void {
    this.child.stdin.end();
  }

  /** 条件に合う行が from 番目以降に出るまで待つ */
  async waitFor(pred: (l: Line) => boolean, from = 0, timeoutMs = 10_000): Promise<Line> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.lines.slice(from).find(pred);
      if (hit) return hit;
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`終了しました。stderr: ${this.stderr}\n${this.raw.join("\n").slice(-2000)}`);
      if (Date.now() > deadline) throw new Error(`待ちきれませんでした。\n${this.raw.join("\n").slice(-2000)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 200);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  /** result の数が n になるまで待つ */
  waitResults(n: number, timeoutMs = 10_000): Promise<Line> {
    return this.waitFor(() => this.lines.filter((l) => l.type === "result").length >= n, 0, timeoutMs).then(() => this.lines.filter((l) => l.type === "result")[n - 1]!);
  }
}

/** 1 回で走らせて終わるまで待つ（-p の文字列入力） */
export async function runOnce(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  const p = new FakeProc(args, opts);
  p.close();
  const exit = await p.exited;
  return { proc: p, exit, lines: p.lines, raw: p.raw };
}

/** 全行が claude-stream.ts の型に合い（unknown・invalid にならない）、normalizeStreamLine を通ることを確かめる */
export function expectValidStream(raw: readonly string[], cwd: string | null = null) {
  for (const line of raw) {
    const m = parseStreamLine(line);
    expect(m.kind, `検査に通らない行: ${line.slice(0, 300)}`).not.toBe("invalid");
    expect(m.kind, `知らない形の行: ${line.slice(0, 300)}`).not.toBe("unknown");
  }
  return normalizeStreamLines(raw, cwd);
}

export const COMMON_ARGS = ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config"];

export function structuredOf(lines: Line[]): unknown {
  const results = lines.filter((l) => l.type === "result");
  return results[results.length - 1]?.structured_output;
}
