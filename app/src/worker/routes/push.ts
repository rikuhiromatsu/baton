// 通知の購読（DESIGN-v2 10.3・10.4・12.2）
import { Hono } from "hono";
import { CreatePushSubscriptionInput, ListPushSubscriptionsOutput, PushSubscriptionViewSchema, isAllowedPushEndpoint } from "@baton/shared";
import { toPushSubscription, type PushSubscriptionRow } from "../db/rows.ts";
import { base64urlDecode, newId } from "../lib/crypto.ts";
import { invalid, notFound } from "../lib/errors.ts";
import { checked, readJson } from "../lib/validate.ts";
import type { AppEnv } from "../types.ts";

export const pushRoutes = new Hono<AppEnv>();

pushRoutes.post("/subscriptions", async (c) => {
  const input = await readJson(c, CreatePushSubscriptionInput);
  // 送り先ホストの制限（SSRF 対策）。e2e だけ偽のプッシュサービス（localhost:8799）を許す
  if (!isAllowedPushEndpoint(input.endpoint, { allowE2E: c.env.BATON_ENV === "e2e" })) throw invalid("push endpoint is not allowed");
  let keyOk = false;
  try {
    keyOk = base64urlDecode(input.keys.p256dh).length === 65 && base64urlDecode(input.keys.auth).length >= 16;
  } catch {
    keyOk = false;
  }
  if (!keyOk) throw invalid("invalid subscription keys");
  const db = c.env.DB;
  const now = Date.now();
  // 同じ endpoint は持ち主・鍵を更新（端末の再購読）
  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label, enabled, failures, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         device_label = excluded.device_label, enabled = 1, failures = 0`,
    )
    .bind(newId(), c.get("user").id, input.endpoint, input.keys.p256dh, input.keys.auth, input.deviceLabel, now)
    .run();
  const row = (await db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").bind(input.endpoint).first<PushSubscriptionRow>())!;
  return c.json(checked(c.env, PushSubscriptionViewSchema, toPushSubscription(row)), 201);
});

pushRoutes.get("/subscriptions", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .bind(c.get("user").id)
    .all<PushSubscriptionRow>();
  return c.json(checked(c.env, ListPushSubscriptionsOutput, { items: results.map(toPushSubscription) }));
});

pushRoutes.delete("/subscriptions/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).run();
  if (res.meta.changes !== 1) throw notFound("subscription not found");
  return c.body(null, 204);
});
