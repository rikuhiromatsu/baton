// tailnet 直結（設計書 1.4）。起動時に {tailnetUrl}/status を 1.5 秒で試し、だめなら何も出さない
import { useTailnet } from "../state/tailnet.ts";

export const TAILNET_PROBE_TIMEOUT_MS = 1500;

type RawLogSource = { close(): void };
export type RawLogOpener = (url: string, onLine: (line: string) => void) => RawLogSource;

type TailnetDriver = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  openRawLog: RawLogOpener;
};

const driver: TailnetDriver = {
  fetch: (input, init) => fetch(input, init),
  openRawLog: (url, onLine) => {
    const es = new EventSource(url);
    es.onmessage = (ev) => onLine(String(ev.data));
    return es;
  },
};

/** モックが差し替える */
export function setTailnetDriver(d: Partial<TailnetDriver>): void {
  Object.assign(driver, d);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function probeTailnet(tailnetUrl: string | null): Promise<boolean> {
  const store = useTailnet.getState();
  if (!tailnetUrl) {
    store.set(null, false);
    return false;
  }
  const base = trimSlash(tailnetUrl);
  if (store.url === base && store.ok) return true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAILNET_PROBE_TIMEOUT_MS);
  try {
    const res = await driver.fetch(`${base}/status`, { method: "GET", mode: "cors", signal: ctrl.signal });
    const ok = res.ok;
    useTailnet.getState().set(base, ok);
    return ok;
  } catch {
    // 失敗してもエラーは出さない（Cloudflare 経由の機能はすべて使える）
    useTailnet.getState().set(base, false);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function tailnetFileUrl(base: string, projectSlug: string, relPath: string): string {
  const path = relPath
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${trimSlash(base)}/files/${encodeURIComponent(projectSlug)}/${path}`;
}

export function openRawLog(base: string, instructionId: string, onLine: (line: string) => void): RawLogSource {
  return driver.openRawLog(`${trimSlash(base)}/logs/${encodeURIComponent(instructionId)}/stream`, onLine);
}
