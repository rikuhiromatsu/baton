// セッションの状態（--session-id / --resume）と、プロセスをまたぐ状態（枠切れ・1 回だけのマーカー）。
// 置き場所は $FAKE_CLAUDE_STATE_DIR（無ければ OS の一時フォルダの fake-claude-state）。
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };

/** メンバーのタスク（[タスク] の入力から覚える。再開で続きをするため） */
export type MemberTask = {
  title: string;
  spec: string;
  paths: string[];
  /** done を返したか */
  completed: boolean;
  /** ask_leader を返したか */
  asked: boolean;
  answer: string | null;
  summary: string | null;
  artifacts: { path: string; title: string }[];
};

export type SessionState = {
  sessionId: string;
  createdAt: number;
  cwd: string;
  role: string | null;
  /** 一度入力に出たら以後も効くマーカー（[scenario-a] など） */
  markers: string[];
  turns: { input: string; at: number; outcome: string }[];
  todos: Todo[];
  member: MemberTask | null;
  /** 台本の進み具合（役割ごとの小さな印） */
  flags: Record<string, string | number | boolean>;
  /** リーダー: 割り振ったタスク（キー → 担当） */
  assignees: Record<string, string>;
};

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FAKE_CLAUDE_STATE_DIR || path.join(os.tmpdir(), "fake-claude-state");
}

function sessionsDir(env?: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), "sessions");
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function sessionPath(id: string, env?: NodeJS.ProcessEnv): string {
  if (!SESSION_ID.test(id)) throw new Error(`Error: Invalid session ID: ${id}`);
  return path.join(sessionsDir(env), `${id}.json`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function sessionExists(id: string, env?: NodeJS.ProcessEnv): boolean {
  return existsSync(sessionPath(id, env));
}

export function loadSession(id: string, env?: NodeJS.ProcessEnv): SessionState | null {
  const file = sessionPath(id, env);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as SessionState;
}

export function saveSession(s: SessionState, env?: NodeJS.ProcessEnv): void {
  writeJsonAtomic(sessionPath(s.sessionId, env), s);
}

export function newSession(id: string, cwd: string): SessionState {
  return { sessionId: id, createdAt: Date.now(), cwd, role: null, markers: [], turns: [], todos: [], member: null, flags: {}, assignees: {} };
}

// ───────────── プロセスをまたぐ状態 ─────────────

type GlobalState = { quotaBlockedUntil: number | null; quotaResetsAtSec: number | null; once: Record<string, number> };

function globalFile(env?: NodeJS.ProcessEnv): string {
  return path.join(stateDir(env), "global.json");
}

export function loadGlobal(env?: NodeJS.ProcessEnv): GlobalState {
  const file = globalFile(env);
  if (!existsSync(file)) return { quotaBlockedUntil: null, quotaResetsAtSec: null, once: {} };
  try {
    return { quotaBlockedUntil: null, quotaResetsAtSec: null, once: {}, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<GlobalState>) };
  } catch {
    return { quotaBlockedUntil: null, quotaResetsAtSec: null, once: {} };
  }
}

/** 並行するメンバーの偽 claude が同時に書いても取りこぼさないよう、mkdir の排他で囲む（2 秒で諦めて書く） */
export function updateGlobal(fn: (g: GlobalState) => void, env?: NodeJS.ProcessEnv): GlobalState {
  const lock = `${globalFile(env)}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 2000;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(lock);
      locked = true;
    } catch {
      if (Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const g = loadGlobal(env);
    fn(g);
    writeJsonAtomic(globalFile(env), g);
    return g;
  } finally {
    if (locked) rmSync(lock, { recursive: true, force: true });
  }
}

/** 「1 回だけ」のマーカー: key で初めてなら true（以後は false） */
export function takeOnce(marker: string, key: string, env?: NodeJS.ProcessEnv): boolean {
  const k = `${marker}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  let first = false;
  updateGlobal((g) => {
    if (g.once[k] === undefined) {
      g.once[k] = Date.now();
      first = true;
    }
  }, env);
  return first;
}

export function shortHash(text: string, len = 6): string {
  return createHash("sha256").update(text).digest("hex").slice(0, len);
}
