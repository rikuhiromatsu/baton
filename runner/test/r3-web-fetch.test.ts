// R3 web_fetch: 127.0.0.1、10.x、192.168.x、100.64.x、169.254.x、::1、*.ts.net、プライベートへのリダイレクトを拒否（DNS は差し替え）。
import { describe, expect, it } from "vitest";
import { defaultLimits } from "../src/config.ts";
import { NetGuardError, checkUrl, isBlockedIp, type LookupFn } from "../src/tools/net-guard.ts";
import { htmlToText, webFetch, type FetchResponseLike, type Transport } from "../src/tools/web-fetch.ts";

const PUBLIC = "93.184.216.34";
const dns: Record<string, string[]> = {
  "example.com": [PUBLIC],
  "redirect.example": [PUBLIC],
  "private.example": ["10.1.2.3"],
  "mixed.example": [PUBLIC, "192.168.1.10"],
  "tailnet.example": ["100.101.102.103"],
  "v6local.example": ["::1"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "ula.example": ["fd7a:115c:a1e0::1"],
};
const lookup: LookupFn = async (host) => {
  const a = dns[host];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

function response(status: number, headers: Record<string, string>, body = ""): FetchResponseLike {
  return {
    status,
    headers,
    body: (async function* () {
      if (body) yield Buffer.from(body);
    })(),
    destroy() {},
  };
}

/** 接続を記録する偽の通信。接続先は checkUrl を通ったアドレスだけのはず */
function fakeTransport(routes: Record<string, () => FetchResponseLike>) {
  const connected: { url: string; addresses: string[] }[] = [];
  const transport: Transport = async (url, { addresses }) => {
    connected.push({ url: url.toString(), addresses: addresses.map((a) => a.address) });
    const r = routes[url.toString()];
    if (!r) throw new Error(`no route ${url}`);
    return r();
  };
  return { transport, connected };
}

const limits = defaultLimits();

describe("R3 web_fetch の宛先検査", () => {
  it.each(["127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.5.4", "192.168.0.1", "100.64.0.1", "100.127.255.254", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "224.0.0.1"])(
    "%s は拒否",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    },
  );

  it.each([PUBLIC, "8.8.8.8", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111"])("%s は通す", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it.each([
    ["http://127.0.0.1/", "IP 直書き"],
    ["http://[::1]:8080/", "IPv6 ループバック"],
    ["http://10.0.0.5/x", "10.x"],
    ["http://192.168.1.1/", "192.168.x"],
    ["http://100.64.1.1/", "CGNAT"],
    ["http://169.254.169.254/latest/meta-data", "リンクローカル"],
    ["https://rikumac-mini.tail6eb659.ts.net/status", "*.ts.net"],
    ["http://localhost:7777/status", "localhost"],
    ["http://private.example/", "名前解決後がプライベート"],
    ["http://mixed.example/", "どれか 1 つでもプライベート"],
    ["http://tailnet.example/", "名前解決後が tailnet"],
    ["http://v6local.example/", "名前解決後が ::1"],
    ["http://mapped.example/", "IPv4 射影のループバック"],
    ["http://ula.example/", "Tailscale の IPv6"],
    ["file:///etc/passwd", "file:"],
    ["ftp://example.com/", "ftp:"],
    ["http://user:pass@example.com/", "認証情報入り"],
  ])("%s を拒否（%s）", async (url) => {
    const { transport, connected } = fakeTransport({});
    await expect(webFetch(url, { limits, lookup, transport })).rejects.toBeInstanceOf(NetGuardError);
    expect(connected).toHaveLength(0);
  });

  it("プライベートへのリダイレクトを拒否する（リダイレクトごとに再検査）", async () => {
    const { transport, connected } = fakeTransport({
      "http://redirect.example/": () => response(302, { location: "http://10.0.0.1/admin" }),
    });
    await expect(webFetch("http://redirect.example/", { limits, lookup, transport })).rejects.toThrow(/接続できません/);
    expect(connected.map((c) => c.url)).toEqual(["http://redirect.example/"]);
  });

  it("名前経由のプライベートへのリダイレクト、*.ts.net へのリダイレクトも拒否", async () => {
    const { transport } = fakeTransport({
      "http://redirect.example/a": () => response(301, { location: "http://private.example/" }),
      "http://redirect.example/b": () => response(307, { location: "https://x.tail6eb659.ts.net/files/" }),
    });
    await expect(webFetch("http://redirect.example/a", { limits, lookup, transport })).rejects.toBeInstanceOf(NetGuardError);
    await expect(webFetch("http://redirect.example/b", { limits, lookup, transport })).rejects.toBeInstanceOf(NetGuardError);
  });

  it("リダイレクトは 3 回まで", async () => {
    const routes: Record<string, () => FetchResponseLike> = {};
    for (let i = 0; i < 5; i++) routes[`http://example.com/${i}`] = () => response(302, { location: `/${i + 1}` });
    routes["http://example.com/3"] = () => response(200, { "content-type": "text/plain" }, "ok");
    const { transport } = fakeTransport(routes);
    const r = await webFetch("http://example.com/0", { limits, lookup, transport });
    expect(r.text).toBe("ok");
    routes["http://example.com/3"] = () => response(302, { location: "/4" });
    await expect(webFetch("http://example.com/0", { limits, lookup, transport })).rejects.toThrow(/リダイレクトが多すぎます/);
  });

  it("公開ページは取得でき、検査済みのアドレスに固定して接続する。HTML は本文テキストにする", async () => {
    const html = `<!doctype html><html><head><title>見出し &amp; タイトル</title><script>alert(1)</script><style>p{}</style></head>
      <body><nav>メニュー</nav><p>本文の&nbsp;一段落目。</p><p>二段落目 &#x3042;</p><footer>フッター</footer></body></html>`;
    const { transport, connected } = fakeTransport({ "http://example.com/page": () => response(200, { "content-type": "text/html; charset=utf-8" }, html) });
    const r = await webFetch("http://example.com/page", { limits, lookup, transport });
    expect(connected[0]?.addresses).toEqual([PUBLIC]);
    expect(r.text).toContain("タイトル: 見出し & タイトル");
    expect(r.text).toContain("本文の 一段落目。");
    expect(r.text).toContain("二段落目 あ");
    expect(r.text).not.toMatch(/alert|メニュー|フッター|p\{\}/);
  });

  it("サイズ（2MB）と文字数（20,000）で切る", async () => {
    const big = "あ".repeat(30_000);
    const { transport } = fakeTransport({ "http://example.com/big": () => response(200, { "content-type": "text/plain" }, big) });
    const r = await webFetch("http://example.com/big", { limits, lookup, transport });
    expect(r.text.length).toBe(20_000);
    expect(r.truncated).toBe(true);
    const r2 = await webFetch("http://example.com/big", { limits: { ...limits, webFetchMaxBytes: 30 }, lookup, transport });
    expect(Buffer.byteLength(r2.text)).toBeLessThanOrEqual(30);
  });

  it("時間切れ（15 秒）で止まる", async () => {
    const transport: Transport = (_url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await expect(webFetch("http://example.com/slow", { limits: { ...limits, webFetchTimeoutMs: 50 }, lookup, transport })).rejects.toThrow();
  });

  it("checkUrl は名前解決できないホストを拒否する", async () => {
    await expect(checkUrl(new URL("http://nowhere.example/"), lookup)).rejects.toBeInstanceOf(NetGuardError);
  });

  it("htmlToText は main/article があれば本文だけを使う", () => {
    const body = "本文".repeat(200);
    expect(htmlToText(`<body><nav>ナビ</nav><article><p>${body}</p></article><aside>広告</aside></body>`)).toBe(body);
  });
});
