// web_fetch の宛先検査（設計書 5.5）。
// 名前解決後のアドレスがプライベート・ループバック・リンクローカル・CGNAT（100.64.0.0/10 ＝ tailnet）などなら拒否。
// `*.ts.net`・localhost も名前の時点で拒否する。
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class NetGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetGuardError";
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultLookup: LookupFn = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT（tailnet）
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local（クラウドのメタデータを含む）
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // ULA（Tailscale の fd7a:115c:a1e0::/48 を含む）
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local（廃止済み）
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** IPv6 の中に埋め込まれた IPv4（::ffff:a.b.c.d、::a.b.c.d、64:ff9b::a.b.c.d）を取り出す */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (m?.[1]) return m[1];
  // ::ffff:7f00:1 の形
  const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (h?.[1] && h[2]) {
    const a = parseInt(h[1], 16);
    const b = parseInt(h[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

export function isBlockedIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return blocked.check(v4, "ipv4");
    if (/^::ffff:/i.test(ip)) return true; // 解釈できない IPv4 射影は拒否
    return blocked.check(ip, "ipv6");
  }
  return true; // IP でないものは拒否
}

export function isBlockedHostname(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "ts.net" || host.endsWith(".ts.net")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  return false;
}

/**
 * URL を検査し、接続してよいアドレスを返す。
 * 返したアドレスに固定して接続する（検査と接続の間に名前解決が変わる DNS リバインディングを防ぐ）。
 */
export async function checkUrl(url: URL, lookup: LookupFn = defaultLookup): Promise<ResolvedAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetGuardError("http(s) の URL だけ取得できます");
  if (url.username || url.password) throw new NetGuardError("URL に認証情報は含められません");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new NetGuardError(`このアドレスには接続できません: ${host}`);
    return [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  }
  if (isBlockedHostname(host)) throw new NetGuardError(`このホストには接続できません: ${host}`);
  let addrs: ResolvedAddress[];
  try {
    addrs = await lookup(host);
  } catch (err) {
    throw new NetGuardError(`名前解決できません: ${host}（${(err as Error).message}）`);
  }
  if (addrs.length === 0) throw new NetGuardError(`名前解決できません: ${host}`);
  const bad = addrs.find((a) => isBlockedIp(a.address));
  if (bad) throw new NetGuardError(`内部ネットワークのアドレスには接続できません: ${host} → ${bad.address}`);
  return addrs;
}
