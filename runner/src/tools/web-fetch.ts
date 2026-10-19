// web_fetch（設計書 5.5）。http(s) のみ・宛先検査・リダイレクト 3 回まで（毎回検査）・15 秒・2MB・HTML は本文テキストにして 20,000 文字。
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import { NetGuardError, checkUrl, defaultLookup, type LookupFn, type ResolvedAddress } from "./net-guard.ts";

export type FetchResponseLike = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
};

/** 実際の接続。addresses（検査済み）以外には接続しないこと */
export type Transport = (url: URL, opts: { addresses: ResolvedAddress[]; signal: AbortSignal }) => Promise<FetchResponseLike>;

export const nodeTransport: Transport = (url, { addresses, signal }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const first = addresses[0];
    if (!first) {
      reject(new NetGuardError("接続先がありません"));
      return;
    }
    // 名前解決を検査済みのアドレスに固定する
    const pinnedLookup = (
      _host: string,
      options: { all?: boolean } | number | undefined,
      cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
    ) => {
      if (typeof options === "object" && options?.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      else cb(null, first.address, first.family);
    };
    const req = mod.request(
      url,
      {
        method: "GET",
        signal,
        lookup: pinnedLookup as unknown as http.RequestOptions["lookup"],
        headers: {
          "user-agent": "BatonRunner/0.1 (+https://baton.rikuhiromatsu.workers.dev)",
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

export type WebFetchLimits = {
  webFetchTimeoutMs: number;
  webFetchMaxBytes: number;
  webFetchMaxChars: number;
  webFetchMaxRedirects: number;
};

export type WebFetchResult = { url: string; status: number; contentType: string; text: string; truncated: boolean };

function header(h: FetchResponseLike["headers"], name: string): string {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML を本文のテキストにする（script・style・ナビゲーション類は除く） */
export function htmlToText(html: string): string {
  let s = html;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(s)?.[2];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 200) s = main;
  else s = s.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|div|section|article|main|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi, "\n");
  s = s.replace(/<(td|th)\b[^>]*>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
  const t = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "";
  return t ? `タイトル: ${t}\n\n${s}` : s;
}

/**
 * URL を取得する。宛先は接続のたびに検査し、リダイレクト先も同じ検査をする。
 */
export async function webFetch(
  rawUrl: unknown,
  opts: { limits: WebFetchLimits; signal?: AbortSignal; lookup?: LookupFn; transport?: Transport },
): Promise<WebFetchResult> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new NetGuardError("url を指定してください");
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new NetGuardError("URL の形式が正しくありません");
  }
  const lookup = opts.lookup ?? defaultLookup;
  const transport = opts.transport ?? nodeTransport;
  const timeout = AbortSignal.timeout(opts.limits.webFetchTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  for (let hop = 0; ; hop++) {
    if (signal.aborted) throw signal.reason;
    const addresses = await checkUrl(url, lookup);
    if (signal.aborted) throw signal.reason;
    const res = await transport(url, { addresses, signal });
    if (res.status >= 300 && res.status < 400 && header(res.headers, "location")) {
      res.destroy();
      if (hop >= opts.limits.webFetchMaxRedirects) throw new NetGuardError(`リダイレクトが多すぎます（${opts.limits.webFetchMaxRedirects} 回まで）`);
      url = new URL(header(res.headers, "location"), url);
      continue;
    }
    // 本文を上限まで読む
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk);
        if (size + b.length > opts.limits.webFetchMaxBytes) {
          chunks.push(b.subarray(0, opts.limits.webFetchMaxBytes - size));
          size = opts.limits.webFetchMaxBytes;
          truncated = true;
          break;
        }
        chunks.push(b);
        size += b.length;
      }
    } finally {
      res.destroy();
    }
    if (signal.aborted) throw signal.reason;
    const buf = Buffer.concat(chunks);
    const contentType = header(res.headers, "content-type").toLowerCase();
    let text: string;
    if (contentType.includes("html") || (!contentType && /^\s*<(!doctype html|html)/i.test(buf.subarray(0, 200).toString("utf8")))) {
      text = htmlToText(buf.toString("utf8"));
    } else if (!contentType || /^text\/|json|xml|javascript|csv|yaml/.test(contentType)) {
      text = buf.toString("utf8");
    } else {
      throw new NetGuardError(`テキストではない内容です（${contentType}）`);
    }
    if (text.length > opts.limits.webFetchMaxChars) {
      text = text.slice(0, opts.limits.webFetchMaxChars);
      truncated = true;
    }
    return { url: url.toString(), status: res.status, contentType, text, truncated };
  }
}
