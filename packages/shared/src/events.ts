// リアルタイムのイベント（設計書 4.5）。
import { z } from "zod";
import {
  AgentEventSchema,
  ArtifactMetaSchema,
  DecisionSchema,
  InstructionSummarySchema,
  RunnerStatusSchema,
  TaskSchema,
  UsageTodaySchema,
} from "./models.ts";

/** サーバー → ブラウザ */
export const ServerEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), serverTime: z.number(), runner: RunnerStatusSchema }),
  z.object({ t: z.literal("instruction.upserted"), instruction: InstructionSummarySchema }),
  z.object({ t: z.literal("task.upserted"), task: TaskSchema }),
  z.object({ t: z.literal("decision.upserted"), decision: DecisionSchema }),
  z.object({ t: z.literal("artifact.created"), artifact: ArtifactMetaSchema }),
  z.object({ t: z.literal("agent_event.appended"), event: AgentEventSchema }),
  z.object({ t: z.literal("runner.status"), runner: RunnerStatusSchema }),
  z.object({ t: z.literal("usage.updated"), usage: UsageTodaySchema }),
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
  z.object({ t: z.literal("subscribe"), instructionId: z.string() }),
  z.object({ t: z.literal("unsubscribe") }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/** サーバー → ランナー */
export const RunnerServerEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), serverTime: z.number() }),
  z.object({ t: z.literal("work.available") }),
  z.object({ t: z.literal("instruction.cancel"), instructionId: z.string() }),
  z.object({ t: z.literal("decision.answered"), instructionId: z.string() }),
]);
export type RunnerServerEvent = z.infer<typeof RunnerServerEventSchema>;

export const WS_PING = "ping";
export const WS_PONG = "pong";

/** 1 つのメッセージを ServerEvent の配列に開く */
export function unpackServerMessage(msg: ServerMessage): ServerEvent[] {
  return msg.t === "batch" ? msg.items : [msg];
}
