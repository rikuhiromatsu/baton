// リアルタイムのイベント（v1 設計書 4.5、DESIGN-v2 12.5）。
// v2 で消したもの: agent_event.appended、usage.updated。
import { z } from "zod";
import {
  AgentSessionSummarySchema,
  ArtifactMetaSchema,
  DecisionSchema,
  InstructionSummarySchema,
  ProjectCountsSchema,
  ProjectProposalSchema,
  ProjectWithTeamSchema,
  QuotaStatusSchema,
  RunnerStatusSchema,
  SessionInputSchema,
  TaskSchema,
  ThreadMessageSchema,
  ThreadSummarySchema,
  TranscriptItemSchema,
  WorkspaceSchema,
} from "./models.ts";

/** サーバー → ブラウザ */
export const ServerEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), serverTime: z.number(), runner: RunnerStatusSchema }),
  z.object({ t: z.literal("instruction.upserted"), instruction: InstructionSummarySchema }),
  z.object({ t: z.literal("task.upserted"), task: TaskSchema }),
  z.object({ t: z.literal("decision.upserted"), decision: DecisionSchema }),
  z.object({ t: z.literal("artifact.created"), artifact: ArtifactMetaSchema }),
  z.object({ t: z.literal("runner.status"), runner: RunnerStatusSchema }),
  // v2（12.5）
  z.object({ t: z.literal("thread.updated"), thread: ThreadSummarySchema }),
  /** 全ブラウザ。本文は 2,000 文字まで（全文は REST） */
  z.object({ t: z.literal("message.upserted"), message: ThreadMessageSchema, bodyTruncated: z.boolean() }),
  /** そのスレッドを開いているブラウザだけ。D1 に書かない（4.7） */
  z.object({
    t: z.literal("message.delta"),
    threadId: z.string(),
    messageId: z.string(),
    offset: z.int().min(0),
    delta: z.string(),
    reset: z.boolean().optional(),
    activity: z.string().nullable().optional(),
  }),
  z.object({ t: z.literal("project_proposal.upserted"), proposal: ProjectProposalSchema }),
  /** 1 秒に 1 回まで */
  z.object({ t: z.literal("session.upserted"), session: AgentSessionSummarySchema }),
  /** その指示を開いているブラウザだけ。body は 2,000 文字まで */
  z.object({ t: z.literal("transcript.appended"), items: z.array(TranscriptItemSchema) }),
  z.object({ t: z.literal("session_input.upserted"), input: SessionInputSchema }),
  z.object({ t: z.literal("workspace.upserted"), workspace: WorkspaceSchema }),
  z.object({ t: z.literal("project.upserted"), project: ProjectWithTeamSchema }),
  z.object({ t: z.literal("project.counts"), projectId: z.string(), counts: ProjectCountsSchema }),
  z.object({ t: z.literal("quota.updated"), quota: QuotaStatusSchema }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["t"];

/** Hub が 100ms 以内のイベントを束ねて送る形 */
export const ServerMessageSchema = z.union([
  ServerEventSchema,
  z.object({ t: z.literal("batch"), items: z.array(ServerEventSchema) }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** ブラウザ → サーバー（生の文字列 "ping" は別扱いで "pong" が返る） */
export const ClientEventSchema = z.discriminatedUnion("t", [
  /** 開いているスレッド・指示（message.delta・transcript.appended の宛先） */
  z.object({ t: z.literal("subscribe"), threadId: z.string().optional(), instructionId: z.string().optional() }),
  z.object({ t: z.literal("unsubscribe") }),
  /** 画面が見えているか（visibilitychange と focus。見えている間は通知を送らない。10.2・D-88） */
  z.object({ t: z.literal("presence"), visible: z.boolean() }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/** サーバー → ランナー */
export const RunnerServerEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), serverTime: z.number() }),
  /** 仕事があるよ（中身は claim で取る） */
  z.object({ t: z.literal("work.available") }),
  z.object({ t: z.literal("instruction.cancel"), instructionId: z.string() }),
  z.object({ t: z.literal("decision.answered"), decisionId: z.string(), sessionId: z.string().nullable(), instructionId: z.string() }),
  // v2（12.5）
  /** ターン中のスレッドに CEO の発言が来た（動いているプロセスの標準入力に流す。4.5） */
  z.object({ t: z.literal("thread.input"), threadId: z.string(), inboxId: z.string() }),
  z.object({ t: z.literal("thread.interrupt"), threadId: z.string() }),
  z.object({ t: z.literal("session.input"), sessionId: z.string(), inputId: z.string() }),
  z.object({ t: z.literal("session.interrupt"), sessionId: z.string() }),
  z.object({ t: z.literal("repos.rescan") }),
]);
export type RunnerServerEvent = z.infer<typeof RunnerServerEventSchema>;

export const WS_PING = "ping";
export const WS_PONG = "pong";

/** 1 つのメッセージを ServerEvent の配列に開く */
export function unpackServerMessage(msg: ServerMessage): ServerEvent[] {
  return msg.t === "batch" ? msg.items : [msg];
}
