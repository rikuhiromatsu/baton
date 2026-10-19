// Service Worker（10.4・v1 7.10）。vite-plugin-pwa の injectManifest で self.__WB_MANIFEST が差し込まれる。
// アプリシェルの precache、画面の移動は index.html、/api は触らない。Web Push の push・notificationclick と、既読で通知を閉じる処理
import {
  FALLBACK_NOTIFICATION,
  cacheNameFor,
  clickTargetUrl,
  manifestUrls,
  notificationFor,
  notificationsToClose,
  parseClientMessage,
  parsePushPayload,
  pickClient,
  routeRequest,
  type ManifestEntry,
} from "./sw-handlers.ts";

// DOM の型で書いているので、Service Worker の分は最小限を自分で書く
type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & { request: Request; respondWith(r: Promise<Response> | Response): void };
type PushEvent = ExtendableEvent & { data: { json(): unknown; text(): string } | null };
type SwNotification = { tag: string; close(): void };
type NotificationEvent = ExtendableEvent & { notification: SwNotification & { data: unknown } };
type WindowClient = { url: string; focused: boolean; visibilityState: string; focus(): Promise<WindowClient>; navigate(url: string): Promise<WindowClient | null> };
type SwScope = {
  __WB_MANIFEST: ManifestEntry[];
  location: Location;
  registration: {
    showNotification(title: string, options: object): Promise<void>;
    getNotifications(filter?: { tag?: string }): Promise<SwNotification[]>;
  };
  clients: { matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<unknown>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, cb: (e: never) => void): void;
};

const sw = self as unknown as SwScope;
// workbox はこの式（self.__WB_MANIFEST）をそのまま探して差し込む
const manifest: ManifestEntry[] = (self as unknown as { __WB_MANIFEST: ManifestEntry[] }).__WB_MANIFEST ?? [];
const CACHE = cacheNameFor(manifest);
const ORIGIN = sw.location.origin;
const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

sw.addEventListener("install", (e: ExtendableEvent) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = manifestUrls(manifest);
      // /index.html は配信側で / へリダイレクトされる。リダイレクトを経た応答は画面の移動に返せないので、/ を取ってリダイレクトの印のない応答として入れる
      await cache.addAll(urls.filter((u) => u !== "/index.html"));
      if (urls.includes("/index.html")) {
        const res = await fetch("/", { cache: "reload" });
        if (!res.ok) throw new Error(`index.html: ${res.status}`);
        await cache.put("/index.html", new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }));
      }
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (e: ExtendableEvent) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("baton-shell-") && key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (e: FetchEvent) => {
  const kind = routeRequest(e.request, ORIGIN);
  if (kind === "bypass") return;
  if (kind === "navigate") {
    e.respondWith(
      (async () => {
        try {
          return await fetch(e.request);
        } catch {
          const cached = await caches.match("/index.html", { cacheName: CACHE, ignoreVary: true });
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }
  e.respondWith(
    (async () => {
      // 配信側が Vary: Origin を付けるので、Origin 付きのモジュールの読み込みが precache（Origin なし）に当たるよう Vary を見ない
      const cached = await caches.match(e.request, { cacheName: CACHE, ignoreVary: true });
      return cached ?? fetch(e.request);
    })(),
  );
});

sw.addEventListener("push", (e: PushEvent) => {
  let raw: unknown = null;
  try {
    raw = e.data?.json() ?? null;
  } catch {
    raw = e.data?.text() ?? null;
  }
  const payload = parsePushPayload(raw);
  const spec = payload ? notificationFor(payload) : FALLBACK_NOTIFICATION;
  e.waitUntil(
    (async () => {
      await sw.registration.showNotification(spec.title, spec.options);
      if (payload) {
        if (payload.unread > 0) await nav.setAppBadge?.(payload.unread).catch(() => {});
        else await nav.clearAppBadge?.().catch(() => {});
      }
    })(),
  );
});

sw.addEventListener("notificationclick", (e: NotificationEvent) => {
  e.notification.close();
  const target = clickTargetUrl(e.notification.data, ORIGIN);
  e.waitUntil(
    (async () => {
      const list = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = pickClient(list, ORIGIN);
      if (client) {
        const focused = await client.focus();
        await focused.navigate(target).catch(() => null);
        return;
      }
      await sw.clients.openWindow(target);
    })(),
  );
});

sw.addEventListener("message", (e: ExtendableEvent & { data: unknown }) => {
  const msg = parseClientMessage(e.data);
  if (!msg) return;
  e.waitUntil(
    (async () => {
      const open = await sw.registration.getNotifications();
      for (const n of notificationsToClose(open, msg.threadIds)) n.close();
      // バッジは開いている画面が未読数から付け直す（MainLayout の useUnreadTitle）。
      // Service Worker の中から Badging API を呼ぶと、Chromium がオフラインから戻った直後に画面ごと落ちることがあった（E16）
    })(),
  );
});
