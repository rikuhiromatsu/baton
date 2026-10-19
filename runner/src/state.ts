// ランナーの手元の小さな状態（<DATA>/run/state/*.json）。再起動をまたいで要るものだけ。
// - セッション: 承認の時間切れで落とした判断・リーダーの答え・タスクの情報（--resume で続けるため）
// - 指示: ラウンド・承認の回数
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataPaths, type RunnerConfig } from "./config.ts";

export type SessionState = {
  sessionId: string;
  instructionId: string | null;
  taskId: string | null;
  workspaceId: string | null;
  cwd: string;
  /** 承認の時間切れ・中断で作った判断 */
  pendingDecisionId?: string | null;
  pendingTool?: { toolName: string; toolInput: Record<string, unknown> } | null;
  /** リーダーの答え（answer_member）。--resume で渡す */
  pendingAnswer?: string | null;
  updatedAt: number;
};

export type InstructionState = {
  instructionId: string;
  round: number;
  approvals: number;
  /** 衝突したタスク（planKey → タスク用ブランチ）。resolve_conflict で使う */
  conflicts?: Record<string, string>;
  updatedAt: number;
};

export class StateStore {
  private readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(config: Pick<RunnerConfig, "dataDir">) {
    this.dir = path.join(dataPaths(config).run, "state");
  }

  private file(kind: string, id: string): string {
    return path.join(this.dir, `${kind}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  async read<T>(kind: string, id: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.file(kind, id), "utf8")) as T;
    } catch {
      return null;
    }
  }

  write<T>(kind: string, id: string, value: T): Promise<void> {
    const job = this.chain.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const f = this.file(kind, id);
      const tmp = `${f}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, f);
    });
    this.chain = job;
    return job;
  }

  async session(id: string): Promise<SessionState | null> {
    return this.read<SessionState>("session", id);
  }
  async patchSession(id: string, patch: Partial<SessionState> & Pick<SessionState, "cwd">): Promise<void> {
    const prev = (await this.session(id)) ?? { sessionId: id, instructionId: null, taskId: null, workspaceId: null, cwd: patch.cwd, updatedAt: 0 };
    await this.write("session", id, { ...prev, ...patch, updatedAt: Date.now() });
  }
  async instruction(id: string): Promise<InstructionState> {
    return (await this.read<InstructionState>("instruction", id)) ?? { instructionId: id, round: 0, approvals: 0, updatedAt: 0 };
  }
  async patchInstruction(id: string, patch: Partial<InstructionState>): Promise<InstructionState> {
    const next = { ...(await this.instruction(id)), ...patch, updatedAt: Date.now() };
    await this.write("instruction", id, next);
    return next;
  }
}
