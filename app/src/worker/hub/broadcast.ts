// Worker から Hub（DO 1 個）へイベントを渡す（設計書 4.5）。
// 配信の失敗は API の結果に影響させない（正本は D1。クライアントは hello で取り直す）。
import type { RunnerServerEvent, ServerEvent } from "@baton/shared";
import type { Env } from "../env.ts";

export function hubStub(env: Env) {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

export async function publish(env: Env, events: ServerEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await hubStub(env).publish(events);
  } catch (err) {
    console.warn("hub publish failed", err);
  }
}

export async function notifyRunners(env: Env, events: RunnerServerEvent[], runnerId?: string): Promise<void> {
  if (events.length === 0) return;
  try {
    await hubStub(env).notifyRunners(events, runnerId);
  } catch (err) {
    console.warn("hub notify failed", err);
  }
}

export async function publishRunnerStatus(env: Env): Promise<void> {
  try {
    await hubStub(env).publishRunnerStatus();
  } catch (err) {
    console.warn("hub runner status failed", err);
  }
}
