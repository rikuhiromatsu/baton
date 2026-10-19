// tailnet 向けのローカル HTTP（設計書 1.4）。127.0.0.1 の BATON_LOCAL_PORT だけで待ち受け、
// `tailscale serve --bg --https=443 http://127.0.0.1:7777` で tailnet 内だけに見せる。
//   GET /status                 ランナーの状態（JSON。claudeAuth・枠・動いているセッション）
//   GET /sessions/:id/stream    セッションの生ログ（SSE。D1 に送る前の項目。8.4）。/logs/:id/stream も同じ
//   GET /diff/:workspaceId      作業場所の差分（unified。13.7 のメンバーのタブ）
//   GET /files/:slug/           作業フォルダの一覧（JSON）
//   GET /files/:slug/*          作業フォルダのファイル本体（読み取り専用、inline）
// 認証: Tailscale-User-Login が ALLOWED_TAILNET_LOGINS に無ければ 403（BATON_LOCAL_AUTH=off のときだけ省く。e2e 用）。
// CORS: BATON_ALLOWED_ORIGINS（既定は本番と localhost:8790）の GET のみ。
import { createReadStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ProjectSlugSchema } from "@baton/shared";
import { workspaceDir, type RunnerConfig } from "./config.ts";
import type { Workspace } from "@baton/shared";
import { runGit } from "./git/git.ts";
import { NotFoundError, listWorkspace, mimeFor } from "./lib/files.ts";
import { PathGuardError, resolveInWorkspace } from "./lib/path-guard.ts";
import type { LiveLog, Logger } from "./log.ts";

export type LocalStatus = {
  activeInstructionIds: string[];
  activeThreadIds: string[];
  activeSessionIds: string[];
  lastHeartbeatAt: number | null;
  hubConnected: boolean;
  claudeAuth: string;
  claudeVersion: string | null;
  quota: unknown;
  authStop: string | null;
};

export type LocalServerDeps = {
  config: RunnerConfig;
  liveLog: LiveLog;
  log: Logger;
  /** 実行中の指示など、その時点の値を返す */
  status: () => LocalStatus;
  /** 見たことのある作業場所 */
  workspace?: (id: string) => Workspace | undefined;
  startedAt?: number;
  /** SSE の keep-alive 間隔 */
  sseKeepAliveMs?: number;
};

const UUIDISH = /^[0-9a-zA-Z-]{1,64}$/;

function corsHeaders(config: RunnerConfig, origin: string | undefined): Record<string, string> {
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET", vary: "Origin" };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(text);
}

export function isAllowedLogin(config: RunnerConfig, header: string | string[] | undefined): boolean {
  if (!config.localAuth) return true;
  const login = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (!login) return false;
  return config.allowedTailnetLogins.some((l) => l.toLowerCase() === login);
}

export function createLocalServer(deps: LocalServerDeps): http.Server {
  const { config, liveLog, log } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const keepAlive = deps.sseKeepAliveMs ?? 15_000;

  return http.createServer((req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const cors = corsHeaders(config, origin);
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      // プリフライト。中身は返さないので認証は要らない（Chrome のローカルネットワークアクセスの問い合わせにも答える）
      const headers: Record<string, string> = { ...cors, "access-control-max-age": "600" };
      if (cors["access-control-allow-origin"] && req.headers["access-control-request-private-network"] === "true") {
        headers["access-control-allow-private-network"] = "true";
      }
      res.writeHead(cors["access-control-allow-origin"] ? 204 : 403, headers);
      res.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: { code: "invalid", message: "GET のみ" } }, { ...cors, allow: "GET" });
      return;
    }
    if (!isAllowedLogin(config, req.headers["tailscale-user-login"])) {
      sendJson(res, 403, { error: { code: "forbidden", message: "forbidden" } }, cors);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: { code: "invalid", message: "bad url" } }, cors);
      return;
    }
    const path = url.pathname;

    void (async () => {
      try {
        if (path === "/status") {
          const s = deps.status();
          let disk: { freeBytes: number; totalBytes: number } | null = null;
          try {
            const fs = await statfs(config.dataDir);
            disk = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
          } catch {
            disk = null;
          }
          sendJson(
            res,
            200,
            {
              name: config.runnerName,
              version: config.version,
              startedAt,
              uptimeMs: Date.now() - startedAt,
              ...s,
              disk,
            },
            cors,
          );
          return;
        }

        const diffMatch = /^\/diff\/([^/]+)$/.exec(path);
        if (diffMatch) {
          const ws = deps.workspace?.(decodeURIComponent(diffMatch[1] ?? ""));
          if (!ws) {
            sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
            return;
          }
          const ref = (await runGit(["-C", ws.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${ws.branch}`], { allowFail: true })).stdout.trim();
          if (!ref) {
            sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
            return;
          }
          const diff = await runGit(["-C", ws.repoPath, "diff", "-M", `${ws.baseSha}..${ref}`], { allowFail: true });
          res.writeHead(200, { ...cors, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(method === "HEAD" ? undefined : diff.stdout.slice(0, 2_000_000));
          return;
        }

        const logMatch = /^\/(?:logs|sessions)\/([^/]+)\/stream$/.exec(path);
        if (logMatch) {
          const id = decodeURIComponent(logMatch[1] ?? "");
          if (!UUIDISH.test(id)) {
            sendJson(res, 400, { error: { code: "invalid", message: "bad id" } }, cors);
            return;
          }
          res.writeHead(200, {
            ...cors,
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
          for (const e of liveLog.backlog(id)) write(e);
          const unsub = liveLog.subscribe(id, write);
          const ka = setInterval(() => res.write(": keep-alive\n\n"), keepAlive);
          const close = () => {
            clearInterval(ka);
            unsub();
          };
          req.on("close", close);
          res.on("close", close);
          return;
        }

        const fileMatch = /^\/files\/([^/]+)\/(.*)$/.exec(path);
        if (fileMatch) {
          const slug = decodeURIComponent(fileMatch[1] ?? "");
          if (!ProjectSlugSchema.safeParse(slug).success) {
            sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
            return;
          }
          const root = workspaceDir(config, slug);
          const rootStat = await stat(root).catch(() => null);
          if (!rootStat?.isDirectory()) {
            sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
            return;
          }
          let rel: string;
          try {
            rel = decodeURIComponent(fileMatch[2] ?? "");
          } catch {
            sendJson(res, 400, { error: { code: "invalid", message: "bad path" } }, cors);
            return;
          }
          if (rel === "" || rel.endsWith("/")) {
            const { entries, truncated } = await listWorkspace(root, rel, 2000);
            sendJson(res, 200, { slug, path: rel, entries, truncated }, cors);
            return;
          }
          const p = await resolveInWorkspace(root, rel);
          const st = p.exists ? await stat(p.abs) : null;
          if (!st?.isFile()) {
            sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
            return;
          }
          const mime = mimeFor(p.rel);
          const name = p.rel.split("/").pop() ?? "file";
          res.writeHead(200, {
            ...cors,
            "content-type": mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime,
            "content-length": String(st.size),
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
            "x-content-type-options": "nosniff",
            // HTML の成果物を開いてもスクリプトを動かさない（同じオリジンの /status 等を読ませない）
            "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
            "cache-control": "no-store",
          });
          if (method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(p.abs).pipe(res);
          return;
        }

        sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
      } catch (err) {
        if (err instanceof NotFoundError) {
          sendJson(res, 404, { error: { code: "not_found", message: "not found" } }, cors);
          return;
        }
        if (err instanceof PathGuardError) {
          sendJson(res, 403, { error: { code: "forbidden", message: err.message } }, cors);
          return;
        }
        log.warn("ローカル HTTP のエラー", { path, error: (err as Error).message });
        if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "internal" } }, cors);
        else res.end();
      }
    })();
  });
}

/** 127.0.0.1 だけで待ち受ける。port 0 なら空いている番号 */
export function listenLocal(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
