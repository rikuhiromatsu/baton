// 偽のプッシュサービス（DESIGN-v2 10.5）。http://localhost:8799/push/<id> で Worker からの送信を受け、
// テストが作った端末の秘密鍵で RFC 8291（aes128gcm）の本文を復号して記録する。VAPID（RFC 8292）のヘッダも記録する。
// Chromium のヘッドレスは本物のプッシュサービスに繋がらないので、ブラウザ側は PushManager.subscribe を差し替えて
// この偽物の endpoint と鍵を返す（installPushStub）。
import crypto from "node:crypto";
import http from "node:http";
import type { BrowserContext } from "@playwright/test";
import { PushPayloadSchema, type PushPayload } from "@baton/shared";
import { PUSH_SERVICE_ORIGIN, PUSH_SERVICE_PORT } from "./env.ts";

export type TestSubscription = {
  id: string;
  endpoint: string;
  /** 端末の公開鍵（非圧縮 65 バイト、base64url）と auth（16 バイト、base64url）。PushSubscription.toJSON().keys と同じ形 */
  keys: { p256dh: string; auth: string };
  privateKey: crypto.KeyObject;
  publicKeyRaw: Buffer;
  authSecret: Buffer;
};

export type ReceivedPush = {
  subscriptionId: string;
  at: number;
  headers: Record<string, string>;
  bodyBytes: number;
  /** 復号した JSON（復号・検査に失敗したら null と error） */
  payload: PushPayload | null;
  error: string | null;
  vapid: { jwtClaims: Record<string, unknown> | null; k: string | null };
};

const b64u = (b: Buffer) => b.toString("base64url");

/** テスト用の端末の鍵と endpoint を作る（P-256 の ECDH 鍵と 16 バイトの auth） */
export function createTestSubscription(label = "e2e"): TestSubscription {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKeyRaw = ecdh.getPublicKey();
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(ecdh.getPrivateKey()),
      x: b64u(publicKeyRaw.subarray(1, 33)),
      y: b64u(publicKeyRaw.subarray(33, 65)),
    },
    format: "jwk",
  });
  const authSecret = crypto.randomBytes(16);
  const id = `${label}-${crypto.randomBytes(6).toString("hex")}`;
  return {
    id,
    endpoint: `${PUSH_SERVICE_ORIGIN}/push/${id}`,
    keys: { p256dh: b64u(publicKeyRaw), auth: b64u(authSecret) },
    privateKey,
    publicKeyRaw,
    authSecret,
  };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

/** RFC 8291 / RFC 8188（aes128gcm、レコード 1 つ）の復号 */
export function decryptAes128gcm(body: Buffer, sub: TestSubscription): Buffer {
  if (body.length < 21) throw new Error("本文が短すぎる");
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20]!;
  const keyid = body.subarray(21, 21 + idlen); // 送り手（Worker）の使い捨て公開鍵
  const ciphertext = body.subarray(21 + idlen);
  if (idlen !== 65) throw new Error(`keyid の長さが 65 ではない: ${idlen}`);
  if (ciphertext.length > rs) throw new Error("レコードが 1 つに収まっていない");
  const asPublic = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(keyid.subarray(1, 33)), y: b64u(keyid.subarray(33, 65)) },
    format: "jwk",
  });
  const ecdhSecret = crypto.diffieHellman({ privateKey: sub.privateKey, publicKey: asPublic });
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), sub.publicKeyRaw, keyid]);
  const ikm = hkdf(sub.authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // 末尾の 0 の詰め物を除き、最後のレコードの区切り 0x02 を外す
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x02) throw new Error("最後のレコードの区切り（0x02）が無い");
  return padded.subarray(0, end);
}

function parseVapid(authorization: string | undefined): ReceivedPush["vapid"] {
  const m = /^vapid\s+t=([^,\s]+),\s*k=([^,\s]+)/i.exec(authorization ?? "");
  if (!m) return { jwtClaims: null, k: null };
  try {
    const claims = JSON.parse(Buffer.from(m[1]!.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return { jwtClaims: claims, k: m[2]! };
  } catch {
    return { jwtClaims: null, k: m[2]! };
  }
}

export type FakePushService = {
  received: ReceivedPush[];
  register(sub: TestSubscription): void;
  /** 次に返す応答のステータス（404・410 で購読が消えることを試す） */
  respondWith(status: number): void;
  forSubscription(id: string): ReceivedPush[];
  close(): Promise<void>;
};

/** 偽のプッシュサービスを 8799 番で立てる（E59 の beforeAll。終わったら close） */
export async function startFakePushService(): Promise<FakePushService> {
  const subs = new Map<string, TestSubscription>();
  const received: ReceivedPush[] = [];
  let nextStatus = 201;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", PUSH_SERVICE_ORIGIN);
    const m = /^\/push\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const id = decodeURIComponent(m[1]!);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
      const record: ReceivedPush = {
        subscriptionId: id,
        at: Date.now(),
        headers,
        bodyBytes: body.length,
        payload: null,
        error: null,
        vapid: parseVapid(headers.authorization),
      };
      const sub = subs.get(id);
      try {
        if (!sub) throw new Error(`知らない購読: ${id}`);
        if (headers["content-encoding"] !== "aes128gcm") throw new Error(`Content-Encoding が aes128gcm ではない: ${headers["content-encoding"]}`);
        const plain = decryptAes128gcm(body, sub).toString("utf8");
        record.payload = PushPayloadSchema.parse(JSON.parse(plain));
      } catch (e) {
        record.error = (e as Error).message;
      }
      received.push(record);
      const status = nextStatus;
      nextStatus = 201;
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // ホストを指定しない（:: で IPv4 も受ける）。Worker は localhost に送るので ::1 と 127.0.0.1 のどちらでも届くように
    server.listen(PUSH_SERVICE_PORT, () => resolve());
  });
  return {
    received,
    register: (sub) => subs.set(sub.id, sub),
    respondWith: (status) => {
      nextStatus = status;
    },
    forSubscription: (id) => received.filter((r) => r.subscriptionId === id),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * ブラウザの PushManager.subscribe / getSubscription / permissionState と Notification の許可を差し替え、
 * テストの購読（偽のプッシュサービスの endpoint と鍵）を返す（10.5）。ページを開く前に呼ぶ
 */
export async function installPushStub(context: BrowserContext, sub: TestSubscription): Promise<void> {
  await context.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      const fromB64u = (s: string) => {
        const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
      };
      const w = window as unknown as { __batonPush?: { subscribed: boolean; subscribeCalls: number; unsubscribed: number } };
      const state = (w.__batonPush ??= { subscribed: false, subscribeCalls: 0, unsubscribed: 0 });
      const makeSub = () => ({
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: (name: string) => (name === "p256dh" ? fromB64u(p256dh) : name === "auth" ? fromB64u(auth) : null),
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          state.subscribed = false;
          state.unsubscribed++;
          return true;
        },
      });
      const PM = (window as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager;
      if (PM) {
        PM.prototype.subscribe = async function () {
          state.subscribeCalls++;
          state.subscribed = true;
          return makeSub();
        };
        PM.prototype.getSubscription = async function () {
          return state.subscribed ? makeSub() : null;
        };
        PM.prototype.permissionState = async function () {
          return "granted";
        };
      }
      const N = (window as unknown as { Notification?: { requestPermission: unknown; permission: string } }).Notification;
      if (N) {
        try {
          Object.defineProperty(N, "permission", { configurable: true, get: () => "granted" });
        } catch {
          /* 変えられない環境では grantPermissions に任せる */
        }
        N.requestPermission = async () => "granted";
      }
    },
    { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  );
}
