// W36 通知（DESIGN-v2 10 章・D-88・D-89）: RFC 8291 の試験用の値で暗号化が一致、VAPID の JWT、送り先の制限、404・410 で購読を消す、
// 失敗 5 回で止める、見えている間（presence）は送らない、15 秒（テストでは環境変数）のまとめ、既読なら送らない、承認はすぐ
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PushPayloadSchema, type PushPayload, type PushSubscriptionView } from "@baton/shared";
import { base64url, base64urlDecode } from "../../src/worker/lib/crypto.ts";
import { decryptPushPayload, encryptPushPayload, importServerKeyPair, p256PointToJwk } from "../../src/worker/push/ece.ts";
import { sendPush } from "../../src/worker/push/send.ts";
import { vapidJwt } from "../../src/worker/push/vapid.ts";
import type { PushSubscriptionRow } from "../../src/worker/db/rows.ts";
import { browser, claim, clearWork, createSession, login, membersInstruction, openSocket, ORIGIN, registerRunner, runner, sleep, type TestSession } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

// RFC 8291 付録 A
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  record:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** テスト用の端末（P-256 の ECDH 鍵と auth） */
async function testDevice() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: kp.privateKey, publicRaw, auth, keys: { p256dh: base64url(publicRaw), auth: base64url(auth) } };
}

let lastDevice: Awaited<ReturnType<typeof testDevice>> | null = null;

type Sent = { url: string; headers: Headers; body: Uint8Array };

/** プッシュサービスへの送信を差し替える（ステータスを順に返す） */
function mockPushService(statuses: number[] = [201]) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname.endsWith("push.apple.com") || req.url.startsWith("http://localhost:8799/push/")) {
      sent.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
      return new Response(null, { status: statuses[Math.min(n++, statuses.length - 1)] });
    }
    return real(input, init);
  });
  return sent;
}

async function subscribe(s: TestSession, endpoint = `https://web.push.apple.com/${crypto.randomUUID()}`) {
  const device = await testDevice();
  const res = await browser(s, "/api/push/subscriptions", { body: { endpoint, keys: device.keys, deviceLabel: "iPhone（PWA）" } });
  if (res.status !== 201) throw new Error(`subscribe ${res.status} ${await res.text()}`);
  lastDevice = device;
  return { device, view: (await res.json()) as PushSubscriptionView, endpoint };
}

async function decrypt(sent: Sent, device: Awaited<ReturnType<typeof testDevice>>): Promise<PushPayload> {
  const plain = await decryptPushPayload(sent.body, device.privateKey, device.publicRaw, device.auth);
  return PushPayloadSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
}

/** 他のテストの購読を消す（送り先を自分の端末だけにする） */
async function onlyMine() {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
}

describe("W36 暗号化と VAPID（ユニット）", () => {
  it("RFC 8291 付録 A の値で暗号化が一致し、受け手の鍵で復号できる", async () => {
    const server = await importServerKeyPair(RFC.asPublic, RFC.asPrivate);
    const out = await encryptPushPayload(base64urlDecode(RFC.plaintext), RFC.uaPublic, RFC.auth, { serverKeyPair: server, salt: base64urlDecode(RFC.salt) });
    expect(base64url(out)).toBe(RFC.record);
    const uaPrivate = await crypto.subtle.importKey("jwk", { ...p256PointToJwk(base64urlDecode(RFC.uaPublic)), d: RFC.uaPrivate }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const plain = await decryptPushPayload(out, uaPrivate, base64urlDecode(RFC.uaPublic), base64urlDecode(RFC.auth));
    expect(new TextDecoder().decode(plain)).toBe("When I grow up, I want to be a watermelon");
  });

  it("VAPID の JWT: ES256、aud は送り先のオリジン、exp は 12 時間、sub。公開鍵で検証できる", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await vapidJwt("https://web.push.apple.com/abc?x=1", { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: "https://baton.rikuhiromatsu.workers.dev" }, now);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(c!)))).toEqual({ aud: "https://web.push.apple.com", exp: now + 12 * 3600, sub: "https://baton.rikuhiromatsu.workers.dev" });
    const pub = await crypto.subtle.importKey("raw", base64urlDecode(env.VAPID_PUBLIC_KEY!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, base64urlDecode(sig!), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });
});

describe("W36 購読と送り先の制限", () => {
  it("許可したホストだけ受け付ける（e2e は偽のプッシュサービスも）。一覧・外す。同じ endpoint は上書き", async () => {
    const s = await login();
    const device = await testDevice();
    const post = (endpoint: string) => browser(s, "/api/push/subscriptions", { body: { endpoint, keys: device.keys } });
    for (const bad of ["https://evil.example.com/push", "http://web.push.apple.com/x", "https://web.push.apple.com:8443/x", "https://user:pw@fcm.googleapis.com/x", "http://localhost:8790/push/x", "http://169.254.169.254/latest"]) {
      expect((await post(bad)).status, bad).toBe(400);
    }
    for (const good of [`https://web.push.apple.com/${crypto.randomUUID()}`, `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`, `https://updates.push.services.mozilla.com/wpush/v2/${crypto.randomUUID()}`, `http://localhost:8799/push/${crypto.randomUUID()}`]) {
      expect((await post(good)).status, good).toBe(201);
    }
    // 本番の設定では偽のプッシュサービスは通らない
    const { callWithEnv } = await import("./helpers.ts");
    const prod = await callWithEnv({ BATON_ENV: "development" }, "/api/push/subscriptions", {
      method: "POST",
      headers: { Cookie: s.cookie, "X-Baton-CSRF": s.csrf, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: `http://localhost:8799/push/${crypto.randomUUID()}`, keys: device.keys }),
    });
    expect(prod.status).toBe(400);
    expect((await browser(s, "/api/push/subscriptions", { body: { endpoint: "https://web.push.apple.com/k", keys: { p256dh: "short", auth: "x" } } })).status).toBe(400);
    const { view } = await subscribe(s);
    expect(view).toMatchObject({ host: "web.push.apple.com", deviceLabel: "iPhone（PWA）", enabled: true });
    const list = (await (await browser(s, "/api/push/subscriptions")).json()) as { items: PushSubscriptionView[] };
    expect(list.items.map((i) => i.id)).toContain(view.id);
    expect(JSON.stringify(list)).not.toContain("p256dh");
    expect((await browser(s, `/api/push/subscriptions/${view.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await browser(s, `/api/push/subscriptions/${view.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("送信: ヘッダ（TTL・Urgency・aes128gcm・VAPID）と本文の長さ。404・410 で購読を消し、その他の失敗 5 回で止める", async () => {
    const s = await login();
    await onlyMine();
    const { device, view, endpoint } = await subscribe(s);
    const row = (await env.DB.prepare("SELECT * FROM push_subscriptions WHERE id = ?").bind(view.id).first<PushSubscriptionRow>())!;
    const sent = mockPushService([201, 500, 500, 500, 500, 500, 410]);
    const payload: PushPayload = { title: "COO", body: "なんの動画ですか？", url: "/", tag: "thread-coo", unread: 1 };
    expect((await sendPush(env, row, payload, { urgent: true })).outcome).toBe("sent");
    expect(sent[0]!.url).toBe(endpoint);
    expect(sent[0]!.headers.get("TTL")).toBe("86400");
    expect(sent[0]!.headers.get("Urgency")).toBe("high");
    expect(sent[0]!.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(sent[0]!.headers.get("Authorization")).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`));
    expect(sent[0]!.body.length).toBeLessThan(4096);
    expect(await decrypt(sent[0]!, device)).toEqual(payload);
    expect((await env.DB.prepare("SELECT last_success_at FROM push_subscriptions WHERE id = ?").bind(view.id).first<{ last_success_at: number | null }>())?.last_success_at).not.toBeNull();
    const outcomes = [];
    for (let n = 0; n < 5; n++) outcomes.push((await sendPush(env, row, payload, { urgent: false })).outcome);
    expect(outcomes).toEqual(["failed", "failed", "failed", "failed", "disabled"]);
    expect(sent[1]!.headers.get("Urgency")).toBe("normal");
    expect((await env.DB.prepare("SELECT enabled, failures FROM push_subscriptions WHERE id = ?").bind(view.id).first())).toEqual({ enabled: 0, failures: 5 });
    expect((await sendPush(env, row, payload, { urgent: false })).outcome).toBe("removed");
    expect(await env.DB.prepare("SELECT 1 FROM push_subscriptions WHERE id = ?").bind(view.id).first()).toBeNull();
  });
});

async function cooMessage(token: string, body: string, notify = true) {
  const r = { token, runnerId: "" };
  const res = await runner(r, "/api/runner/threads/thread-coo/messages", {
    body: { id: crypto.randomUUID(), authorKind: "coo", authorAgentId: null, kind: "chat", body, instructionId: null, sessionId: null, ref: {}, status: "complete", notify },
  });
  return ((await res.json()) as { message: { seq: number; id: string } }).message;
}

describe("W36 通知のまとめ（Hub）", () => {
  it("画面を隠していれば、まとめて 1 通（同じスレッドは最新 1 件、url と未読）。見えている間は送らない", async () => {
    const s = await login();
    const r = await registerRunner();
    await onlyMine();
    await clearWork();
    await browser(s, "/api/threads/thread-coo/read", { body: { seq: 999999 } });
    const { device } = await subscribe(s);
    const sent = mockPushService();
    const ws = await openSocket("/api/ws", { Origin: ORIGIN, Cookie: s.cookie });
    await ws.waitFor((e) => e.t === "hello");
    // 見えている（presence: true が既定）→ 送らない
    await cooMessage(r.token, "見ている間の発言");
    await sleep(600);
    expect(sent).toHaveLength(0);
    ws.ws.send(JSON.stringify({ t: "presence", visible: false }));
    await sleep(50);
    await browser(s, "/api/threads/thread-coo/read", { body: { seq: 999999 } });
    await cooMessage(r.token, "一通目");
    await cooMessage(r.token, "チームリーダーから 10 本の案が上がって来ました。1. 産地別");
    await cooMessage(r.token, "通知しない発言", false);
    await sleep(800);
    expect(sent).toHaveLength(1);
    const p = await decrypt(sent[0]!, device);
    expect(p).toMatchObject({ title: "COO", url: "/", tag: "thread-coo", unread: 2 });
    expect(p.body.startsWith("チームリーダーから 10 本の案")).toBe(true);
    ws.close();
  });

  it("複数スレッドは 1 通に「ほか n 件」。送る直前に既読なら送らない", async () => {
    const s = await login();
    const r = await registerRunner();
    await onlyMine();
    await clearWork();
    const { createProject } = await import("./helpers.ts");
    const proj = await createProject(r, undefined, "台本");
    await subscribe(s);
    const sent = mockPushService();
    await cooMessage(r.token, "COO から");
    const lr = await runner(r, `/api/runner/threads/${proj.leaderThreadId}/messages`, {
      body: { id: crypto.randomUUID(), authorKind: "leader", authorAgentId: null, kind: "chat", body: "リーダーから", instructionId: null, sessionId: null, ref: {}, status: "complete", notify: true },
    });
    expect(lr.status).toBe(201);
    await sleep(800);
    expect(sent).toHaveLength(1);
    const title = (await decryptAny(sent[0]!)).title;
    expect(title === "リーダー · 台本 ほか 1 件" || title === "COO ほか 1 件").toBe(true);
    // 既読にしてからまとめが来ると送らない
    const m = await cooMessage(r.token, "すぐ読む");
    await browser(s, "/api/threads/thread-coo/read", { body: { seq: m.seq } });
    await sleep(800);
    expect(sent).toHaveLength(1);
  });

  it("承認待ちはまとめずにすぐ送る（url は承認カード）", async () => {
    const s = await login();
    const r = await registerRunner();
    await onlyMine();
    await clearWork();
    const { device } = await subscribe(s);
    const sent = mockPushService();
    const a = await membersInstruction(r);
    await claim(r, ["instruction"]);
    const sid = await createSession(r, { instructionId: a.id });
    await runner(r, "/api/runner/approvals", { body: { id: crypto.randomUUID(), instructionId: a.id, sessionId: sid, taskId: null, askedByAgentId: null, toolName: "Bash", toolInput: {}, toolUseId: null, question: "npm install zod" } });
    await sleep(100);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("Urgency")).toBe("high");
    expect(await decrypt(sent[0]!, device)).toMatchObject({ title: "承認待ち", body: "npm install zod", url: `/i/${a.id}?s=${sid}` });
  });
});

/** 最後に購読した端末の鍵で復号する */
async function decryptAny(sent: Sent): Promise<PushPayload> {
  if (!lastDevice) throw new Error("no device");
  return decrypt(sent, lastDevice);
}
