// モックの REST（12.2 のブラウザ用 API）。MockBackend.handle に差し込む
import {
  BOT_TOKEN_PREFIX,
  COO_THREAD_ID,
  LIMITS,
  nextStatus,
  type BotScope,
  type ListMessagesOutput,
  type ProjectProposal,
  type SessionInput,
  type TranscriptOutput,
} from "@baton/shared";
import { COO_AUTHOR, uuid, type MockBackend } from "./backend.ts";

function json(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installRest(b: MockBackend): void {
  b.handle = async (method, path, query, body) => {
    let m: RegExpMatchArray | null;

    // ───── 会話 ─────
    if (method === "GET" && path === "/api/threads") {
      return json(200, { items: [...b.threads.values()].map((t) => b.threadView(t)) });
    }
    if ((m = path.match(/^\/api\/threads\/([^/]+)\/messages$/))) {
      const rec = b.threads.get(decodeURIComponent(m[1]!));
      if (!rec) return error(404, "not_found", "thread");
      if (method === "GET") {
        const before = query.get("before");
        const all = rec.messages;
        const filtered = before ? all.filter((x) => x.seq < Number(before)) : all;
        const items = filtered.slice(-LIMITS.messagesPage);
        const out: ListMessagesOutput = { items, hasMoreBefore: filtered.length > items.length };
        return json(200, out);
      }
      if (method === "POST") {
        const text = typeof body.body === "string" ? body.body.trim() : "";
        if (!text || text.length > LIMITS.ceoMessageMaxChars || typeof body.clientId !== "string") return error(400, "invalid", "body");
        const dup = rec.messages.find((x) => x.clientId === body.clientId);
        if (dup) return json(201, { message: dup });
        const ref: Record<string, unknown> = {};
        if (typeof body.contextProjectId === "string") ref.contextProjectId = body.contextProjectId;
        const msg = b.addMessage(rec.summary.id, { kind: "ceo", agentId: null, name: null }, text, {
          clientId: body.clientId,
          instructionId: typeof body.instructionId === "string" ? body.instructionId : null,
          ref,
        });
        // CEO 自身の発言は既読（未読に数えない）
        rec.lastReadSeq = Math.max(rec.lastReadSeq, msg.seq);
        b.onCeoMessage(rec.summary.id, msg);
        return json(201, { message: msg });
      }
    }
    if (method === "POST" && (m = path.match(/^\/api\/threads\/([^/]+)\/read$/))) {
      const rec = b.threads.get(decodeURIComponent(m[1]!));
      if (!rec) return error(404, "not_found", "thread");
      rec.lastReadSeq = Math.max(rec.lastReadSeq, Number(body.seq) || 0);
      b.emitThread(rec.summary.id);
      return json(204);
    }
    if (method === "POST" && (m = path.match(/^\/api\/threads\/([^/]+)\/leave$/))) return json(204);
    if (method === "POST" && (m = path.match(/^\/api\/threads\/([^/]+)\/interrupt$/))) {
      b.interruptThread(decodeURIComponent(m[1]!));
      return json(202, {});
    }
    if (method === "POST" && (m = path.match(/^\/api\/threads\/([^/]+)\/reset$/))) {
      const id = decodeURIComponent(m[1]!);
      if (!b.threads.has(id)) return error(404, "not_found", "thread");
      const msg = b.addMessage(id, { kind: "system", agentId: null, name: null }, "新しい話題", { kind: "notice", ref: { notice: "new_topic" } });
      return json(200, { message: msg });
    }

    // ───── プロジェクト案 ─────
    if ((m = path.match(/^\/api\/project-proposals\/([^/]+)(\/accept|\/decline)?$/))) {
      const p = b.proposals.get(decodeURIComponent(m[1]!));
      if (!p) return error(404, "not_found", "proposal");
      if (method === "GET" && !m[2]) return json(200, { proposal: p });
      if (method === "POST" && m[2] === "/accept") {
        if (p.status !== "pending") return error(409, "conflict", "proposal");
        const ws = body.workspace as { kind?: string; repoPath?: string } | undefined;
        let workspace = p.workspace;
        if (ws?.kind === "baton") workspace = { kind: "baton" };
        if (ws?.kind === "repo") {
          const repo = b.repos.find((r) => r.path === ws.repoPath);
          if (!repo) return error(400, "invalid", "repoPath");
          workspace = { kind: "repo", repoPath: repo.path, repoName: repo.name };
        }
        const project = b.addProject({
          slug: p.slug,
          name: p.name,
          goal: p.goal,
          summary: p.summary,
          repo: workspace.kind === "repo" ? { path: workspace.repoPath, name: workspace.repoName, baseBranch: "main" } : null,
          leader: p.leader,
          members: p.members,
        });
        const next: ProjectProposal = { ...p, status: "accepted", projectId: project.id, workspace, decidedAt: b.now() };
        b.proposals.set(p.id, next);
        b.broadcast({ t: "project_proposal.upserted", proposal: next });
        b.broadcast({ t: "project.upserted", project });
        b.onAcceptProposal(next, project);
        return json(201, { project, proposal: next });
      }
      if (method === "POST" && m[2] === "/decline") {
        const next: ProjectProposal = { ...p, status: "declined", decidedAt: b.now() };
        b.proposals.set(p.id, next);
        b.broadcast({ t: "project_proposal.upserted", proposal: next });
        b.onDeclineProposal(next);
        return json(204);
      }
    }

    // ───── 指示 ─────
    if (method === "GET" && path === "/api/instructions") {
      if (b.listDelay) await wait(b.listDelay);
      const view = query.get("view") === "archived" ? "archived" : "active";
      const projectId = query.get("projectId");
      const items = [...b.insts.values()]
        .map((r) => r.summary)
        .filter((s) => (view === "archived" ? s.status === "archived" : s.status !== "archived"))
        .filter((s) => !projectId || s.projectId === projectId)
        .sort((a, c) => c.statusChangedAt - a.statusChangedAt);
      return json(200, { items, nextCursor: null });
    }
    if ((m = path.match(/^\/api\/instructions\/([^/]+)$/)) && method === "GET") {
      const rec = b.insts.get(decodeURIComponent(m[1]!));
      return rec ? json(200, b.detail(rec)) : error(404, "not_found", "instruction");
    }
    if ((m = path.match(/^\/api\/instructions\/([^/]+)\/diff$/)) && method === "GET") {
      const rec = b.insts.get(decodeURIComponent(m[1]!));
      return rec ? json(200, b.diff(rec)) : error(404, "not_found", "instruction");
    }
    if ((m = path.match(/^\/api\/instructions\/([^/]+)\/transition$/)) && method === "POST") {
      const rec = b.insts.get(decodeURIComponent(m[1]!));
      if (!rec) return error(404, "not_found", "instruction");
      const action = body.action as Parameters<typeof nextStatus>[1];
      if (body.expectedStatus !== rec.summary.status) return error(409, "conflict", "status");
      const from = rec.summary.status;
      const to = action === "restore" ? rec.archivedFrom : nextStatus(from, action);
      if (!to) return error(409, "conflict", "transition");
      if (action === "archive") rec.archivedFrom = from;
      const log = b.recordTransition(rec, action, from, to);
      if (action === "cancel") b.cancelInstruction(rec.summary.id);
      b.setInst(rec, { status: to, ...(action === "send_back" ? { phase: "coo" } : {}) });
      b.onTransition(rec, action, typeof body.comment === "string" ? body.comment : undefined);
      return json(200, { instruction: rec.summary, transitionId: log.id });
    }
    if ((m = path.match(/^\/api\/transitions\/([^/]+)\/undo$/)) && method === "POST") {
      const log = b.transitions.find((t) => t.id === m![1]);
      if (!log || log.undone || b.now() - log.at > LIMITS.undoServerWindowMs) return error(409, "conflict", "undo");
      const rec = b.insts.get(log.instructionId);
      if (!rec || rec.summary.status !== log.to) return error(409, "conflict", "undo");
      log.undone = true;
      if (log.action === "cancel") b.resumeInstruction(rec.summary.id);
      b.setInst(rec, { status: log.from });
      return json(200, { instruction: rec.summary });
    }
    if ((m = path.match(/^\/api\/decisions\/([^/]+)\/answer$/)) && method === "POST") {
      const res = b.answer(decodeURIComponent(m[1]!), {
        verdict: body.verdict === "allow" || body.verdict === "deny" ? body.verdict : undefined,
        answer: typeof body.answer === "string" ? body.answer : undefined,
      });
      return res ? json(200, res) : error(409, "conflict", "decision");
    }
    if ((m = path.match(/^\/api\/artifacts\/([^/]+)$/)) && method === "GET") {
      for (const rec of b.insts.values()) {
        const a = rec.artifacts.find((x) => x.id === m![1]);
        if (a) return json(200, a);
      }
      return error(404, "not_found", "artifact");
    }

    // ───── セッション ─────
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/transcript$/)) && method === "GET") {
      const id = decodeURIComponent(m[1]!);
      const all = (b.transcripts.get(id) ?? []).filter((it) => !query.get("instructionId") || it.instructionId === query.get("instructionId"));
      const before = query.get("before");
      const after = query.get("after");
      let list = all;
      if (before) list = list.filter((it) => it.seq < Number(before));
      if (after) list = list.filter((it) => it.seq > Number(after));
      const items = list.slice(-LIMITS.transcriptPage);
      const out: TranscriptOutput = { items, hasMoreBefore: list.length > items.length };
      return json(200, out);
    }
    if ((m = path.match(/^\/api\/transcript-items\/([^/]+)$/)) && method === "GET") {
      for (const list of b.transcripts.values()) {
        const it = list.find((x) => x.id === m![1]);
        if (it) return json(200, it);
      }
      return error(404, "not_found", "item");
    }
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && method === "POST") {
      const id = decodeURIComponent(m[1]!);
      for (const rec of b.insts.values()) {
        const s = rec.sessions.find((x) => x.id === id);
        if (!s) continue;
        const dup = b.inputs.find((x) => x.clientId === body.clientId);
        if (dup) return json(202, { input: dup });
        const input: SessionInput = {
          id: uuid(),
          clientId: String(body.clientId),
          sessionId: id,
          instructionId: rec.summary.id,
          body: String(body.body ?? "").trim(),
          status: "pending",
          createdAt: b.now(),
          deliveredAt: null,
        };
        b.inputs.push(input);
        b.broadcast({ t: "session_input.upserted", input });
        b.onFollowup(rec, s, input);
        return json(202, { input });
      }
      return error(404, "not_found", "session");
    }
    if ((m = path.match(/^\/api\/sessions\/([^/]+)\/interrupt$/)) && method === "POST") {
      const id = decodeURIComponent(m[1]!);
      for (const rec of b.insts.values()) {
        const s = rec.sessions.find((x) => x.id === id);
        if (!s) continue;
        if (s.status === "running") {
          b.setSession(rec, s, { status: "paused", pauseReason: "interrupted", activity: null });
          b.addItem(s, "system", { author: "runner", summary: "中断", body: {} });
          b.openDecision(rec, s, { kind: "interrupted", toolName: null, toolInput: null, question: s.title });
        }
        return json(202, {});
      }
      return error(404, "not_found", "session");
    }

    // ───── 組織・プロジェクト ─────
    if (method === "GET" && path === "/api/org") return json(200, b.org());
    if (method === "GET" && path === "/api/projects/sidebar") return json(200, b.sidebar());
    if (method === "GET" && path === "/api/projects") return json(200, { items: b.projects });
    if (method === "POST" && path === "/api/projects") {
      const repo = b.repos.find((r) => r.path === body.repoPath);
      if (!repo) return error(400, "invalid", "repoPath");
      const proposal: ProjectProposal = {
        id: uuid(),
        threadId: COO_THREAD_ID,
        messageId: null,
        status: "pending",
        projectId: null,
        name: repo.name.split("/").pop() ?? repo.name,
        slug: (repo.name.split("/").pop() ?? "repo").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40),
        goal: "このリポジトリで進める仕事の目的を、COO との会話で固めます。",
        summary: repo.path,
        workspace: { kind: "repo", repoPath: repo.path, repoName: repo.name },
        leader: { name: "ノア", specialty: "既存のコードを読んで段取りを組む" },
        members: [{ name: "イオ", specialty: "実装とテスト", profile: "engineer" }],
        createdAt: b.now(),
        decidedAt: null,
      };
      const msg = b.addMessage(COO_THREAD_ID, COO_AUTHOR, `${repo.name} で進めるプロジェクトの案です。目的を一緒に固めましょう。`, {
        kind: "project_proposal",
        notify: true,
        ref: { proposalId: proposal.id },
      });
      const withMsg = { ...proposal, messageId: msg.id };
      b.proposals.set(proposal.id, withMsg);
      b.broadcast({ t: "project_proposal.upserted", proposal: withMsg });
      return json(201, { proposal: withMsg });
    }
    if ((m = path.match(/^\/api\/projects\/([^/]+)$/)) && method === "PATCH") {
      const p = b.projects.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!p) return error(404, "not_found", "project");
      const running = [...b.insts.values()].some((r) => r.summary.projectId === p.id && ["running", "queued", "needs_decision"].includes(r.summary.status));
      if ("repoPath" in body) {
        if (running) return error(409, "conflict", "running");
        if (body.repoPath === null) {
          const r = b.repos.find((x) => x.path === p.repoPath);
          if (r) r.projectId = null;
          Object.assign(p, { workspaceKind: "baton", repoPath: null, repoName: null, baseBranch: null });
        } else {
          const repo = b.repos.find((r) => r.path === body.repoPath);
          if (!repo) return error(400, "invalid", "repoPath");
          repo.projectId = p.id;
          Object.assign(p, { workspaceKind: "repo", repoPath: repo.path, repoName: repo.name, baseBranch: repo.defaultBranch });
        }
      }
      if (typeof body.goal === "string") p.goal = body.goal;
      p.updatedAt = b.now();
      b.broadcast({ t: "project.upserted", project: p });
      return json(200, { project: p });
    }
    if (method === "GET" && path === "/api/repos") return json(200, { items: b.repos });
    if (method === "GET" && path === "/api/profiles") return json(200, { items: b.profiles });
    if (method === "GET" && path === "/api/quota") return json(200, { ...b.quota, estimatedCostTodayUsd: b.estimatedCostTodayUsd });

    // ───── 通知 ─────
    if (path === "/api/push/subscriptions") {
      if (method === "GET") return json(200, { items: b.pushSubs });
      if (method === "POST") {
        const endpoint = String(body.endpoint ?? "");
        const host = (() => {
          try {
            return new URL(endpoint).host;
          } catch {
            return "";
          }
        })();
        if (!host) return error(400, "invalid", "endpoint");
        const exists = b.pushSubs.find((x) => x.host === host && x.deviceLabel === body.deviceLabel);
        const item = exists ?? { id: uuid(), deviceLabel: String(body.deviceLabel ?? ""), host, enabled: true, createdAt: b.now(), lastSuccessAt: null };
        if (!exists) b.pushSubs.push(item);
        return json(201, { item });
      }
    }
    if ((m = path.match(/^\/api\/push\/subscriptions\/([^/]+)$/)) && method === "DELETE") {
      b.pushSubs = b.pushSubs.filter((x) => x.id !== m![1]);
      return json(204);
    }

    // ───── 秘書のトークン ─────
    if (path === "/api/bot-tokens") {
      if (method === "GET") return json(200, { items: b.botTokens });
      if (method === "POST") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const scopes = Array.isArray(body.scopes) ? (body.scopes as BotScope[]) : [];
        if (!name || scopes.length === 0) return error(400, "invalid", "token");
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = `${BOT_TOKEN_PREFIX}${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
        const item = { id: uuid(), name, scopes, createdAt: b.now(), lastUsedAt: null, revokedAt: null };
        b.botTokens.unshift(item);
        return json(201, { token, item });
      }
    }
    if ((m = path.match(/^\/api\/bot-tokens\/([^/]+)$/)) && method === "DELETE") {
      const t = b.botTokens.find((x) => x.id === m![1]);
      if (t && !t.revokedAt) t.revokedAt = b.now();
      return json(204);
    }
    if ((m = path.match(/^\/api\/bot-tokens\/([^/]+)\/audit$/)) && method === "GET") {
      return json(200, { items: b.botAudit.filter((x) => x.tokenId === m![1]), nextCursor: null });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      b.loggedIn = false;
      return json(204);
    }
    return error(404, "not_found", path);
  };
}
