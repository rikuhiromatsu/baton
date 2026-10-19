// 通知の組み立てと送信（DESIGN-v2 10.2・10.3）
import { LIMITS, PushPayloadSchema, UI_TEXT_V2, type PushPayload } from "@baton/shared";
import type { Env } from "../env.ts";
import { clip } from "../lib/json.ts";
import type { PushSubscriptionRow } from "../db/rows.ts";
import { encryptPushPayload } from "./ece.ts";
import { vapidAuthorization } from "./vapid.ts";

/** Worker が Hub に渡す「通知の候補」 */
export type PushCandidate = {
  /** 発言なら そのスレッドと seq（送る直前に既読を見直す） */
  threadId: string | null;
  seq: number | null;
  title: string;
  body: string;
  url: string;
  /** 同じ tag は置き換わる（スレッドごとにまとまる） */
  tag: string;
  /** 承認・判断はまとめずにすぐ送る */
  urgent: boolean;
  at: number;
};

/** その利用者の未読（notify=1 の発言）の合計 */
export async function unreadTotal(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM thread_messages m
        WHERE m.notify = 1 AND m.status = 'complete'
          AND m.seq > COALESCE((SELECT r.last_read_seq FROM thread_reads r WHERE r.thread_id = m.thread_id AND r.user_id = ?), 0)`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 候補を 1 つの通知にまとめる。既読になったものは落とす。同じ tag は最新 1 件、複数あれば「COO ほか 2 件」。
 * 送るものが無ければ null。
 */
export async function composePushPayload(db: D1Database, userId: string, candidates: PushCandidate[]): Promise<PushPayload | null> {
  const live: PushCandidate[] = [];
  for (const c of candidates) {
    if (c.threadId !== null && c.seq !== null) {
      const read = await db
        .prepare("SELECT last_read_seq FROM thread_reads WHERE user_id = ? AND thread_id = ?")
        .bind(userId, c.threadId)
        .first<{ last_read_seq: number }>();
      if ((read?.last_read_seq ?? 0) >= c.seq) continue;
    }
    live.push(c);
  }
  if (live.length === 0) return null;
  const byTag = new Map<string, PushCandidate>();
  for (const c of live) {
    const prev = byTag.get(c.tag);
    if (!prev || prev.at <= c.at) byTag.set(c.tag, c);
  }
  const groups = [...byTag.values()].sort((a, b) => b.at - a.at);
  const latest = groups[0]!;
  const title = groups.length > 1 ? `${latest.title} ${UI_TEXT_V2.org.others} ${groups.length - 1} ${UI_TEXT_V2.org.count}` : latest.title;
  const payload: PushPayload = {
    title: clip(title, 60),
    body: clip(latest.body.replace(/\s+/g, " ").trim(), LIMITS.pushBodyChars),
    url: latest.url,
    tag: clip(groups.length > 1 ? "baton" : latest.tag, 100),
    unread: await unreadTotal(db, userId),
  };
  return PushPayloadSchema.parse(payload);
}

export type PushResult = { subscriptionId: string; status: number | null; outcome: "sent" | "removed" | "failed" | "disabled" };

function vapidKeys(env: Env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || env.APP_ORIGIN };
}

/** 1 つの購読へ送る。404・410 は購読を消し、その他の失敗は failures +1、5 回で enabled=0 */
export async function sendPush(env: Env, sub: PushSubscriptionRow, payload: PushPayload, opts: { urgent: boolean }): Promise<PushResult> {
  const keys = vapidKeys(env);
  if (!keys) return { subscriptionId: sub.id, status: null, outcome: "failed" };
  const db = env.DB;
  let status: number | null = null;
  try {
    const body = await encryptPushPayload(new TextEncoder().encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: String(LIMITS.pushTtlSec),
        Urgency: opts.urgent ? "high" : "normal",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: await vapidAuthorization(sub.endpoint, keys),
      },
      body,
    });
    status = res.status;
    await res.body?.cancel();
  } catch (err) {
    console.warn("push send failed", err);
  }
  const now = Date.now();
  if (status !== null && status >= 200 && status < 300) {
    await db.prepare("UPDATE push_subscriptions SET failures = 0, last_success_at = ? WHERE id = ?").bind(now, sub.id).run();
    return { subscriptionId: sub.id, status, outcome: "sent" };
  }
  if (status === 404 || status === 410) {
    await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
    return { subscriptionId: sub.id, status, outcome: "removed" };
  }
  const row = await db
    .prepare(
      `UPDATE push_subscriptions SET failures = failures + 1, enabled = CASE WHEN failures + 1 >= ? THEN 0 ELSE enabled END
        WHERE id = ? RETURNING enabled`,
    )
    .bind(LIMITS.pushMaxFailures, sub.id)
    .first<{ enabled: number }>();
  return { subscriptionId: sub.id, status, outcome: row?.enabled === 0 ? "disabled" : "failed" };
}

/** その利用者の有効な購読すべてに送る */
export async function deliverPushToUser(env: Env, userId: string, payload: PushPayload, opts: { urgent: boolean }): Promise<PushResult[]> {
  if (!vapidKeys(env)) {
    console.warn("VAPID keys are not configured; skip push");
    return [];
  }
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? AND enabled = 1").bind(userId).all<PushSubscriptionRow>();
  const out: PushResult[] = [];
  for (const sub of results) out.push(await sendPush(env, sub, payload, opts));
  return out;
}
