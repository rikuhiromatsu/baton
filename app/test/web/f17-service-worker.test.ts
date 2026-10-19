// F17 Service Worker の push・notificationclick・既読で閉じる処理（純粋関数。10.4・10.5）
import { describe, expect, it } from "vitest";
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
} from "../../src/web/sw-handlers.ts";

const ORIGIN = "https://baton.rikuhiromatsu.workers.dev";

describe("F17 push", () => {
  it("中身を読み、同じ tag で置き換わる通知にする", () => {
    const p = parsePushPayload({ title: "COO", body: "チームリーダーから 10 本の案が上がって来ました。", url: "/", tag: "thread-coo", unread: 3 })!;
    expect(p.unread).toBe(3);
    const n = notificationFor(p);
    expect(n.title).toBe("COO");
    expect(n.options).toMatchObject({ body: p.body, tag: "thread-coo", data: { url: "/" } });
    // 文字列でも読める
    expect(parsePushPayload(JSON.stringify({ title: "COO", body: "", url: "/i/x", tag: "t", unread: 0 }))?.url).toBe("/i/x");
  });

  it("壊れた中身は null（呼び出し側は最低限の通知を出す。iOS は表示の無い通知を許さない）", () => {
    expect(parsePushPayload("{")).toBeNull();
    expect(parsePushPayload({ title: "x", url: "https://evil.example/" })).toBeNull();
    expect(FALLBACK_NOTIFICATION.title).toBe("Baton");
  });
});

describe("F17 notificationclick", () => {
  it("同じオリジンのパスだけ開く。外は / に落とす", () => {
    expect(clickTargetUrl({ url: "/i/abc?s=s1" }, ORIGIN)).toBe(`${ORIGIN}/i/abc?s=s1`);
    expect(clickTargetUrl({ url: "//evil.example/x" }, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTargetUrl({ url: "https://evil.example/" }, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTargetUrl(null, ORIGIN)).toBe(`${ORIGIN}/`);
  });

  it("開いている画面があればそれを前に出す（フォーカス → 見えている → 同じオリジン）。無ければ null（新しく開く）", () => {
    const a = { url: `${ORIGIN}/org`, focused: false, visibilityState: "hidden" };
    const b = { url: `${ORIGIN}/`, focused: false, visibilityState: "visible" };
    const c = { url: "https://other.example/", focused: true, visibilityState: "visible" };
    expect(pickClient([a, b, c], ORIGIN)).toBe(b);
    expect(pickClient([a], ORIGIN)).toBe(a);
    expect(pickClient([c], ORIGIN)).toBeNull();
  });
});

describe("F17 既読で通知を閉じる", () => {
  it("既読にしたスレッドの tag の通知だけ閉じる", () => {
    const ns = [{ tag: "thread-coo" }, { tag: "thread-leader-x" }, { tag: "decision-1" }];
    expect(notificationsToClose(ns, ["thread-coo"])).toEqual([{ tag: "thread-coo" }]);
  });

  it("画面からの連絡を読む", () => {
    expect(parseClientMessage({ t: "read", threadIds: ["thread-coo", 3], unread: 2 })).toEqual({ threadIds: ["thread-coo"], unread: 2 });
    expect(parseClientMessage({ t: "other" })).toBeNull();
    expect(parseClientMessage({ t: "read", threadIds: [], unread: -1 })).toEqual({ threadIds: [], unread: 0 });
  });
});

describe("F17 アプリシェル", () => {
  it("/api と /mcp は触らない。画面の移動は index.html、ほかは静的ファイル", () => {
    expect(routeRequest({ method: "GET", url: `${ORIGIN}/api/threads`, mode: "cors" }, ORIGIN)).toBe("bypass");
    expect(routeRequest({ method: "POST", url: `${ORIGIN}/`, mode: "navigate" }, ORIGIN)).toBe("bypass");
    expect(routeRequest({ method: "GET", url: `${ORIGIN}/mcp`, mode: "cors" }, ORIGIN)).toBe("bypass");
    expect(routeRequest({ method: "GET", url: `${ORIGIN}/org`, mode: "navigate" }, ORIGIN)).toBe("navigate");
    expect(routeRequest({ method: "GET", url: `${ORIGIN}/assets/a.js`, mode: "no-cors" }, ORIGIN)).toBe("asset");
    expect(routeRequest({ method: "GET", url: "https://cdn.example/x.js", mode: "no-cors" }, ORIGIN)).toBe("bypass");
  });

  it("precache の一覧とキャッシュの名前（中身が変わると名前が変わる）", () => {
    expect(manifestUrls(["index.html", { url: "/assets/a.js", revision: null }])).toEqual(["/index.html", "/assets/a.js"]);
    expect(cacheNameFor([{ url: "a", revision: "1" }])).not.toBe(cacheNameFor([{ url: "a", revision: "2" }]));
    expect(cacheNameFor([])).toMatch(/^baton-shell-/);
  });
});
