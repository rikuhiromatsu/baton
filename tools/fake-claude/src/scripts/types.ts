// 台本の部品の型。台本はジェネレーターで、1 手ずつ Step を出し、道具の結果を受け取る。
import type { TurnLine } from "@baton/shared";
import type { SessionState } from "../store.ts";

export type Role = "coo" | "leader" | "member";

export type Step =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  /** StructuredOutput（--json-schema のときだけ出る） */
  | { kind: "output"; value: unknown }
  | { kind: "sleep"; ms: number };

/** 道具の結果（text・output・sleep では null） */
export type StepResult = { ok: boolean; denied: boolean; content: string; toolUseResult: unknown } | null;

export type Script = Generator<Step, void, StepResult>;

export type TurnContext = {
  role: Role | null;
  /** ランナーが書いた入力の全文 */
  input: string;
  /** 札ごとに分けたもの（turn-input.ts の parseTurnInput） */
  lines: TurnLine[];
  /** 入力とセッションのマーカー（[scenario-a] → "scenario-a"） */
  markers: Set<string>;
  session: SessionState;
  cwd: string;
  /** --json-schema（無ければ null） */
  schema: Record<string, unknown> | null;
  env: NodeJS.ProcessEnv;
};
