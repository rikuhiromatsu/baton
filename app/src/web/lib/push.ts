// Web Push の購読（10.4）。許可は利用者の操作のときだけ求める。モックとテストは driver を差し替える
import type { CreatePushSubscriptionInput } from "@baton/shared";

export type PushSupport = "supported" | "ios-needs-install" | "unsupported";

export type PushDriver = {
  /** この端末で Web Push が使えるか（iOS は ホーム画面に追加した PWA の中だけ） */
  support: () => PushSupport;
  permission: () => NotificationPermission | "unsupported";
  requestPermission: () => Promise<NotificationPermission>;
  /** pushManager.subscribe の結果（JSON の形） */
  subscribe: (applicationServerKey: string) => Promise<PushSubscriptionJSON>;
  /** いまの端末の購読（無ければ null） */
  current: () => Promise<PushSubscriptionJSON | null>;
  unsubscribe: () => Promise<void>;
};

export function isIos(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator): boolean {
  const ua = nav.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS は Mac と名乗る
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (window.matchMedia?.("(display-mode: standalone)").matches ?? false);
}

/** 端末の判定（純粋関数。F18 で検査） */
export function pushSupportOf(env: { ios: boolean; standalone: boolean; hasPushManager: boolean; hasServiceWorker: boolean; hasNotification: boolean }): PushSupport {
  if (env.ios && !env.standalone) return "ios-needs-install";
  if (!env.hasPushManager || !env.hasServiceWorker || !env.hasNotification) return "unsupported";
  return "supported";
}

function base64UrlToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const browserDriver: PushDriver = {
  support: () =>
    pushSupportOf({
      ios: typeof navigator !== "undefined" && isIos(),
      standalone: isStandalone(),
      hasPushManager: typeof window !== "undefined" && "PushManager" in window,
      hasServiceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator,
      hasNotification: typeof window !== "undefined" && "Notification" in window,
    }),
  permission: () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  requestPermission: () => Notification.requestPermission(),
  subscribe: async (key) => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
    return sub.toJSON();
  },
  current: async () => {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? sub.toJSON() : null;
  },
  unsubscribe: async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  },
};

let driver: PushDriver = browserDriver;
export function setPushDriver(d: PushDriver | null): void {
  driver = d ?? browserDriver;
}
export function getPushDriver(): PushDriver {
  return driver;
}

/** 端末の名前（設定の一覧に出す。固定文言を増やさないよう、OS とブラウザの名前だけ） */
export function deviceLabel(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Web";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}

/** 許可を求めて購読し、サーバーに送る入力を作る（利用者の操作の中で呼ぶ） */
export async function subscribeThisDevice(vapidPublicKey: string): Promise<CreatePushSubscriptionInput | null> {
  if (driver.support() !== "supported") return null;
  const perm = driver.permission() === "granted" ? "granted" : await driver.requestPermission();
  if (perm !== "granted") return null;
  const json = await driver.subscribe(vapidPublicKey);
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, deviceLabel: deviceLabel() };
}

// ───────────── Service Worker への連絡（既読で通知を閉じる。10.4） ─────────────

export type SwMessage = { t: "read"; threadIds: string[]; unread: number };

export function postToServiceWorker(msg: SwMessage): void {
  try {
    navigator.serviceWorker?.controller?.postMessage(msg);
  } catch {
    // 無視
  }
}

/** アプリのバッジ（PWA）。0 なら消す */
export function setAppBadge(n: number): void {
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> });
  try {
    if (n > 0) void nav?.setAppBadge?.(n)?.catch(() => {});
    else void nav?.clearAppBadge?.()?.catch(() => {});
  } catch {
    // 無視
  }
}
