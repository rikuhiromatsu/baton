// FakeBatonApi を HTTP（12.3 のパス）で出す。ランナーを子プロセスで起動するテスト（R12）用。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeBatonApi } from "./fake-api.ts";

type Route = [method: string, pattern: RegExp, handler: (api: FakeBatonApi, m: RegExpExecArray, body: any) => Promise<unknown>];

const ROUTES: Route[] = [
  ["POST", /^\/api\/runner\/heartbeat$/, (a, _m, b) => a.heartbeat(b)],
  ["POST", /^\/api\/runner\/claim$/, (a, _m, b) => a.claim(b)],
  ["POST", /^\/api\/runner\/threads\/([^/]+)\/messages$/, async (a, m, b) => ({ message: await a.postMessage(m[1]!, b) })],
  ["PATCH", /^\/api\/runner\/threads\/([^/]+)\/messages\/([^/]+)$/, async (a, m, b) => ({ message: await a.patchMessage(m[1]!, m[2]!, b) })],
  ["POST", /^\/api\/runner\/threads\/([^/]+)\/stream$/, (a, m, b) => a.stream(m[1]!, b)],
  ["POST", /^\/api\/runner\/threads\/([^/]+)\/inbox$/, (a, m, b) => a.pushInbox(m[1]!, b)],
  ["POST", /^\/api\/runner\/threads\/([^/]+)\/turn-done$/, (a, m, b) => a.turnDone(m[1]!, b)],
  ["POST", /^\/api\/runner\/threads\/([^/]+)\/release$/, (a, m, b) => a.releaseThread(m[1]!, b)],
  ["POST", /^\/api\/runner\/sessions$/, async (a, _m, b) => ({ session: await a.createSession(b) })],
  ["PATCH", /^\/api\/runner\/sessions\/([^/]+)$/, async (a, m, b) => ({ session: await a.patchSession(m[1]!, b) })],
  ["POST", /^\/api\/runner\/transcript$/, async (a, _m, b) => (await a.appendTranscript(b), { accepted: b.items.length, lastSeqBySession: {} })],
  ["POST", /^\/api\/runner\/instructions\/([^/]+)\/release$/, (a, m, b) => a.releaseInstruction(m[1]!, b)],
  ["PATCH", /^\/api\/runner\/instructions\/([^/]+)$/, async (a, m, b) => ({ instruction: await a.patchInstruction(m[1]!, b) })],
  ["POST", /^\/api\/runner\/instructions$/, async (a, _m, b) => ({ instruction: await a.createInstruction(b) })],
  ["POST", /^\/api\/runner\/projects$/, (a, _m, b) => a.createProject(b)],
  ["GET", /^\/api\/runner\/workspaces/, async (a) => ({ items: await a.listWorkspaces({}) })],
  ["PUT", /^\/api\/runner\/repos$/, (a, _m, b) => a.putRepos(b)],
];

export async function serveFakeApi(api: FakeBatonApi): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://x");
        const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
        if (!route) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end('{"error":{"code":"not_found","message":"x"}}');
          return;
        }
        try {
          const out = await route[2](api, route[1].exec(url.pathname)!, raw ? JSON.parse(raw) : undefined);
          if (out === null || out === undefined) {
            res.writeHead(url.pathname.endsWith("/claim") ? 204 : 200);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "conflict", message: String(err) } }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
