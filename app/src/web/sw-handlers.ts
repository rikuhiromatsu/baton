// Service Worker の処理のうち、テストできる純粋な部分（10.4・F17）
// Service Worker に zod（共有パッケージの値）を持ち込まないよう、型だけ使って手で検査する
import type { PushPayload } from "@baton/shared";

/** 通知の中身を読む（壊れていたら null。iOS は表示の無い通知を許さないので、呼び出し側は最低限の通知を出す） */
export function parsePushPayload(raw: unknown): PushPayload | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (k: string, max: number) => typeof v[k] === "string" && (v[k] as string).length <= max;
  if (!str("title", 60) || !str("body", 200) || !str("tag", 100) || typeof v.url !== "string" || !v.url.startsWith("/")) return null;
  if (typeof v.unread !== "number" || !Number.isInteger(v.unread) || v.unread < 0) return null;
  return { title: v.title as string, body: v.body as string, url: v.url, tag: v.tag as string, unread: v.unread };
}

export type NotificationSpec = {
  title: string;
  options: { body: string; tag: string; data: { url: string }; icon: string; badge: string; renotify: boolean };
};

/** showNotification に渡すもの。同じ tag は置き換わる（スレッドごとにまとまる） */
export function notificationFor(p: PushPayload): NotificationSpec {
  return {
    title: p.title,
    options: { body: p.body, tag: p.tag, data: { url: p.url }, icon: "/pwa-192x192.png", badge: "/pwa-64x64.png", renotify: true },
  };
}

/** 中身が読めなかったときの最低限の通知 */
export const FALLBACK_NOTIFICATION: NotificationSpec = {
  title: "Baton",
  options: { body: "", tag: "baton", data: { url: "/" }, icon: "/pwa-192x192.png", badge: "/pwa-64x64.png", renotify: false },
};

/** 押したときに開く URL（同じオリジンのパスだけ。ほかは / に落とす） */
export function clickTargetUrl(data: unknown, origin: string): string {
  const url = data && typeof data === "object" ? (data as { url?: unknown }).url : null;
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return new URL("/", origin).href;
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? u.href : new URL("/", origin).href;
  } catch {
    return new URL("/", origin).href;
  }
}

export type ClientLike = { url: string; focused?: boolean; visibilityState?: string };

/** 開いている画面があれば、それを前に出して移動する（見えているもの → 同じオリジンのもの） */
export function pickClient<T extends ClientLike>(clients: readonly T[], origin: string): T | null {
  const same = clients.filter((c) => {
    try {
      return new URL(c.url).origin === origin;
    } catch {
      return false;
    }
  });
  return same.find((c) => c.focused) ?? same.find((c) => c.visibilityState === "visible") ?? same[0] ?? null;
}

/** 既読にしたスレッドの通知を閉じる（tag はスレッドの ID。10.4） */
export function notificationsToClose<T extends { tag: string }>(notifications: readonly T[], threadIds: readonly string[]): T[] {
  const set = new Set(threadIds);
  return notifications.filter((n) => set.has(n.tag));
}

/** 画面からの連絡（既読） */
export function parseClientMessage(data: unknown): { threadIds: string[]; unread: number } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { t?: unknown; threadIds?: unknown; unread?: unknown };
  if (d.t !== "read" || !Array.isArray(d.threadIds)) return null;
  return { threadIds: d.threadIds.filter((x): x is string => typeof x === "string"), unread: typeof d.unread === "number" && d.unread >= 0 ? Math.floor(d.unread) : 0 };
}

// ───────────── アプリシェルのキャッシュ（v1 7.10 を自前で） ─────────────

export type ManifestEntry = string | { url: string; revision?: string | null };

export function manifestUrls(entries: readonly ManifestEntry[]): string[] {
  return entries.map((e) => (typeof e === "string" ? e : e.url)).map((u) => (u.startsWith("/") ? u : `/${u}`));
}

/** キャッシュの名前（中身が変わったら新しい名前になる） */
export function cacheNameFor(entries: readonly ManifestEntry[]): string {
  let h = 0;
  for (const e of entries) {
    const s = typeof e === "string" ? e : `${e.url}@${e.revision ?? ""}`;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return `baton-shell-${(h >>> 0).toString(36)}`;
}

/** fetch をどう扱うか: /api と /mcp は触らない、画面の移動は index.html、静的ファイルはキャッシュ優先 */
export function routeRequest(req: { method: string; url: string; mode: string }, origin: string): "bypass" | "navigate" | "asset" {
  if (req.method !== "GET") return "bypass";
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return "bypass";
  }
  if (u.origin !== origin) return "bypass";
  if (u.pathname.startsWith("/api/") || u.pathname === "/mcp" || u.pathname.startsWith("/cdn-cgi/")) return "bypass";
  if (req.mode === "navigate") return "navigate";
  return "asset";
}
