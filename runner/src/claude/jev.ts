// TypeSafe の System One API（判定モデル Jev）のクライアントと、鍵の読み方（DESIGN-v2 5.9.1・D-132・D-134）。
// ランナー（サンドボックスの外の親プロセス）だけが呼ぶ。鍵はログ・D1・トランスクリプト・子の環境・claude の引数に出さない。
// 出すのは出どころ（env / settings / none）だけ。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readDecision, requestBody, type Decision } from "./jev-policy.ts";

export type KeySource = "env" | "settings" | "none";

export type JevResult = {
  decision: Decision | null;
  /** 問い合わせにかかった時間 */
  ms: number;
  /** 失敗の短い語（timeout / http 500 / bad_body / no_key / error）。成功なら null。鍵・本文は入れない */
  error: string | null;
};

export type JevStatus = {
  keySource: KeySource;
  /** 最後に問い合わせた時刻（UNIX ミリ秒） */
  lastAt: number | null;
  lastError: string | null;
};

/** ctx.jev。テストは偽の Jev に差し替える */
export interface JevClient {
  decide(state: Record<string, unknown>): Promise<JevResult>;
  status(): JevStatus;
}

export type HttpJevOptions = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** BATON_TYPESAFE_API_KEY（空なら無し） */
  envKey: string | null;
  /** 本人のホーム（~/.claude/settings.json の基準） */
  home: string;
  now?: () => number;
};

const SETTINGS_KEYS = ["jev-model-router@skills-dir", "jev-model-router"] as const;

function pickKey(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const configs = (settings as { pluginConfigs?: unknown }).pluginConfigs;
  if (!configs || typeof configs !== "object") return null;
  for (const name of SETTINGS_KEYS) {
    const entry = (configs as Record<string, unknown>)[name];
    const key = (entry as { options?: { typesafeApiKey?: unknown } } | undefined)?.options?.typesafeApiKey;
    if (typeof key === "string" && key.trim()) return key.trim();
  }
  return null;
}

export class HttpJevClient implements JevClient {
  private readonly opts: HttpJevOptions;
  private readonly settingsPath: string;
  private cache: { mtimeMs: number; size: number; key: string | null } | null = null;
  private last: { at: number | null; error: string | null } = { at: null, error: null };

  constructor(opts: HttpJevOptions) {
    this.opts = opts;
    this.settingsPath = path.join(opts.home, ".claude/settings.json");
  }

  /** 鍵と出どころ。settings.json は mtime が変わったときだけ読み直す。壊れていても落ちない */
  private resolveKey(): { key: string | null; source: KeySource } {
    const envKey = this.opts.envKey?.trim();
    if (envKey) return { key: envKey, source: "env" };
    try {
      const st = statSync(this.settingsPath);
      if (!this.cache || this.cache.mtimeMs !== st.mtimeMs || this.cache.size !== st.size) {
        let key: string | null = null;
        try {
          key = pickKey(JSON.parse(readFileSync(this.settingsPath, "utf8")));
        } catch {
          key = null;
        }
        this.cache = { mtimeMs: st.mtimeMs, size: st.size, key };
      }
      return this.cache.key ? { key: this.cache.key, source: "settings" } : { key: null, source: "none" };
    } catch {
      this.cache = null;
      return { key: null, source: "none" };
    }
  }

  status(): JevStatus {
    return { keySource: this.resolveKey().source, lastAt: this.last.at, lastError: this.last.error };
  }

  async decide(state: Record<string, unknown>): Promise<JevResult> {
    const now = this.opts.now ?? Date.now;
    const started = performance.now();
    const done = (decision: Decision | null, error: string | null): JevResult => {
      this.last = { at: now(), error };
      return { decision, ms: Math.round(performance.now() - started), error };
    };
    const { key } = this.resolveKey();
    if (!key) return done(null, "no_key");
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: requestBody(state, this.opts.model),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return done(null, `http ${res.status}`);
      }
      const decision = readDecision(await res.text());
      return decision ? done(decision, null) : done(null, "bad_body");
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return done(null, name === "TimeoutError" || name === "AbortError" ? "timeout" : "error");
    }
  }
}
