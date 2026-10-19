// Worker 統合テストの共通の道具
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { CSRF_HEADER, TEST_SECRET_HEADER, unpackServerMessage, type InstructionSummary, type ProjectWithTeam, type ServerEvent, type ServerMessage } from "@baton/shared";
import app from "../../src/worker/index.ts";
import type { Env } from "../../src/worker/env.ts";

export const ORIGIN = "http://localhost:8790";
export const BASE = "http://localhost:8790";
export const TEST_SECRET = "e2e-local-secret";

/** 本物の入口（exports.default）を通す */
export function call(path: string, init?: RequestInit): Promise<Response> {
  return (exports as unknown as { default: { fetch: (input: string, init?: RequestInit) => Promise<Response> } }).default.fetch(
    `${BASE}${path}`,
    init,
  );
}

/** env を差し替えて Hono アプリを直接呼ぶ（本番の設定など） */
export async function callWithEnv(overrides: Partial<Env>, url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url.startsWith("http") ? url : `${BASE}${url}`, init), { ...env, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export type TestSession = { cookie: string; csrf: string; userId: string; email: string };

export function cookieFrom(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [k, ...rest] = pair!.split("=");
    if (k?.trim() === name) return rest.join("=");
  }
  return null;
}

export async function login(email = "ceo@example.com"): Promise<TestSession> {
  const res = await call("/api/test/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", [TEST_SECRET_HEADER]: TEST_SECRET },
    body: JSON.stringify({ email, name: "CEO" }),
  });
  if (res.status !== 200) throw new Error(`test login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { csrfToken: string; user: { id: string } };
  const token = cookieFrom(res, "baton_session");
  if (!token) throw new Error("no session cookie");
  return { cookie: `baton_session=${token}`, csrf: body.csrfToken, userId: body.user.id, email };
}

export function browser(s: TestSession, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { Cookie: s.cookie, ...(init.headers ?? {}) };
  if (method !== "GET") {
    headers[CSRF_HEADER] ??= s.csrf;
    headers.Origin ??= ORIGIN;
    headers["Content-Type"] ??= "application/json";
  }
  return call(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

export type TestRunner = { token: string; runnerId: string };

export async function registerRunner(): Promise<TestRunner> {
  const res = await call("/api/test/runner-token", { method: "POST", headers: { [TEST_SECRET_HEADER]: TEST_SECRET } });
  if (res.status !== 200) throw new Error(`runner-token failed: ${res.status}`);
  return (await res.json()) as TestRunner;
}

export function runner(r: TestRunner | string, path: string, init: { method?: string; body?: unknown } = {}) {
  const token = typeof r === "string" ? r : r.token;
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  return call(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** D1 に直接指示を入れる（状態を作るため） */
export async function insertInstruction(
  userId: string,
  fields: {
    status?: string;
    createdAt?: number;
    statusChangedAt?: number;
    notBefore?: number | null;
    leaseRunnerId?: string | null;
    leaseExpiresAt?: number | null;
    body?: string;
    title?: string | null;
    projectId?: string | null;
    phase?: string | null;
    revision?: number;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const createdAt = fields.createdAt ?? now - 3_600_000;
  await env.DB.prepare(
    `INSERT INTO instructions (id, client_id, created_by, body, title, status, status_changed_at, not_before, lease_runner_id, lease_expires_at, project_id, phase, revision,
                               origin_thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'thread-coo', ?, ?)`,
  )
    .bind(
      id,
      crypto.randomUUID(),
      userId,
      fields.body ?? "直接入れた指示",
      fields.title ?? null,
      fields.status ?? "queued",
      fields.statusChangedAt ?? createdAt,
      fields.notBefore ?? null,
      fields.leaseRunnerId ?? null,
      fields.leaseExpiresAt ?? null,
      fields.projectId ?? null,
      fields.phase ?? null,
      fields.revision ?? 1,
      createdAt,
      createdAt,
    )
    .run();
  return id;
}

export type TestProject = { project: ProjectWithTeam; leaderThreadId: string; leaderId: string; memberIds: string[] };

/** ランナーの delegate new と同じ経路で Baton 専用のプロジェクトを作る */
export async function createProject(r: TestRunner, slug = `p-${crypto.randomUUID().slice(0, 8)}`, name = "テストのプロジェクト"): Promise<TestProject> {
  const res = await runner(r, "/api/runner/projects", {
    body: {
      name,
      slug,
      goal: "テストの目的",
      summary: "要約",
      leader: { name: "リーダー", specialty: "まとめ" },
      members: [
        { name: "リサーチ", specialty: "調べる", profile: "researcher" },
        { name: "ライター", specialty: "書く", profile: "writer" },
      ],
    },
  });
  if (res.status !== 201) throw new Error(`create project failed: ${res.status} ${await res.text()}`);
  const out = (await res.json()) as { project: ProjectWithTeam; leaderThreadId: string };
  return {
    ...out,
    leaderId: out.project.agents.find((a) => a.role === "leader")!.id,
    memberIds: out.project.agents.filter((a) => a.role === "member").map((a) => a.id),
  };
}

/** ランナーが指示を作る（COO の delegate） */
export async function runnerCreateInstruction(r: TestRunner, projectId: string, fields: { title?: string; body?: string; phase?: string } = {}): Promise<InstructionSummary> {
  const res = await runner(r, "/api/runner/instructions", {
    body: {
      id: crypto.randomUUID(),
      title: fields.title ?? "テストの指示",
      body: fields.body ?? "COO の依頼の本文",
      projectId,
      originThreadId: "thread-coo",
      originMessageId: null,
      phase: fields.phase ?? "leader",
    },
  });
  if (res.status !== 201) throw new Error(`create instruction failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as InstructionSummary;
}

export async function postCeo(s: TestSession, threadId: string, body: string, extra: Record<string, unknown> = {}) {
  return browser(s, `/api/threads/${threadId}/messages`, { body: { clientId: crypto.randomUUID(), body, ...extra } });
}

export async function claim(r: TestRunner, kinds: string[] = ["thread", "instruction", "finalize"], extra: Record<string, unknown> = {}) {
  return runner(r, "/api/runner/claim", { body: { kinds, activeThreadIds: [], activeInstructionIds: [], quotaPaused: false, ...extra } });
}

/** ランナーのセッションを作る */
export async function createSession(r: TestRunner, fields: Record<string, unknown>): Promise<string> {
  const id = (fields.id as string | undefined) ?? crypto.randomUUID();
  const res = await runner(r, "/api/runner/sessions", {
    body: { id, threadId: null, instructionId: null, agentId: null, role: "member", projectId: null, taskId: null, workspaceId: null, title: "メンバー", cwd: "/tmp/x", model: "sonnet", ...fields },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create session failed: ${res.status} ${await res.text()}`);
  return id;
}

/** 他のテストの影響を受けないよう、取り出し待ちのものを片付ける */
export async function clearWork(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE instructions SET status = 'archived' WHERE status IN ('queued','running','done','needs_decision','review')"),
    env.DB.prepare("UPDATE thread_inbox SET status = 'consumed' WHERE status = 'pending'"),
    env.DB.prepare("UPDATE threads SET status = 'idle', lease_runner_id = NULL, lease_expires_at = NULL, not_before = NULL"),
  ]);
}

export async function statusOf(id: string): Promise<string | undefined> {
  return (await env.DB.prepare("SELECT status FROM instructions WHERE id = ?").bind(id).first<{ status: string }>())?.status;
}


// ───────────── WebSocket ─────────────

export type TestSocket = {
  ws: WebSocket;
  events: ServerEvent[];
  raw: string[];
  waitFor<T = ServerEvent>(pred: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<T>;
  waitForRaw(pred: (m: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
};

export async function openSocket(path: string, headers: Record<string, string>): Promise<TestSocket> {
  const res = await call(path, { headers: { Upgrade: "websocket", ...headers } });
  if (res.status !== 101 || !res.webSocket) throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  ws.accept();
  const events: ServerEvent[] = [];
  const raw: string[] = [];
  const listeners = new Set<() => void>();
  ws.addEventListener("message", (m) => {
    const data = typeof m.data === "string" ? m.data : "";
    raw.push(data);
    try {
      const parsed = JSON.parse(data) as ServerMessage;
      if (parsed && typeof parsed === "object" && "t" in parsed) events.push(...unpackServerMessage(parsed));
    } catch {
      // "pong" など
    }
    for (const l of listeners) l();
  });
  const wait = <R>(check: () => R | undefined, timeoutMs: number, what: string) =>
    new Promise<R>((resolve, reject) => {
      const hit = check();
      if (hit !== undefined) return resolve(hit);
      const timer = setTimeout(() => {
        listeners.delete(l);
        reject(new Error(`timeout waiting for ${what}; got ${JSON.stringify(raw).slice(0, 2000)}`));
      }, timeoutMs);
      const l = () => {
        const h = check();
        if (h !== undefined) {
          clearTimeout(timer);
          listeners.delete(l);
          resolve(h);
        }
      };
      listeners.add(l);
    });
  return {
    ws,
    events,
    raw,
    waitFor: <T>(pred: (e: ServerEvent) => boolean, timeoutMs = 3000) =>
      wait(() => events.find(pred) as T | undefined, timeoutMs, "event"),
    waitForRaw: (pred, timeoutMs = 3000) => wait(() => raw.find(pred), timeoutMs, "raw message"),
    close: () => ws.close(1000, "done"),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** メンバーの段階の指示（pending の work タスク 1 つ）を作る */
export async function membersInstruction(r: TestRunner, projectId?: string): Promise<{ id: string; projectId: string; taskId: string }> {
  const pid = projectId ?? (await createProject(r)).project.id;
  const inst = await runnerCreateInstruction(r, pid);
  const patch = await runner(r, `/api/runner/instructions/${inst.id}`, { method: "PATCH", body: { status: "running", phase: "members" } });
  if (patch.status !== 200) throw new Error(`patch ${patch.status} ${await patch.text()}`);
  const taskId = crypto.randomUUID();
  const t = await runner(r, "/api/runner/tasks", {
    body: { tasks: [{ id: taskId, instructionId: inst.id, parentTaskId: null, assigneeAgentId: null, kind: "work", planKey: "t1", dependsOn: [], title: "調べる", spec: "s", paths: ["research/"], round: 1, seq: 0 }] },
  });
  if (t.status !== 201) throw new Error(`tasks ${t.status} ${await t.text()}`);
  return { id: inst.id, projectId: pid, taskId };
}

