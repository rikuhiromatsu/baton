// ブラウザ用 API（v1 設計書 4.2、DESIGN-v2 12.2）を E2E から直接呼ぶ薄いクライアント。
// 前提づくり（会話から指示を作る等）と、画面の結果をサーバー側でも確かめるために使う。
// v2: CEO は指示を直接作らない（D-73）。指示は COO に話しかけて作る（createInstructionViaChat）。
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import {
  API_PATHS,
  COO_THREAD_ID,
  CSRF_HEADER,
  type AcceptProposalInput,
  type AcceptProposalOutput,
  type AnswerDecisionInput,
  type AnswerDecisionOutput,
  type BotScope,
  type BotTokenView,
  type CeoAction,
  type CreateBotTokenOutput,
  type InstructionDetail,
  type InstructionStatus,
  type InstructionSummary,
  type ListInstructionsOutput,
  type ListMessagesOutput,
  type OrgSnapshot,
  type ProfileView,
  type ProjectWithTeam,
  type PushSubscriptionView,
  type QuotaOutput,
  type RepoCandidate,
  type SessionInfo,
  type SidebarOutput,
  type ThreadMessage,
  type ThreadSummary,
  type TranscriptItem,
  type TranscriptOutput,
  type TransitionOutput,
} from "@baton/shared";
import { BASE_URL, RUNNER_TIMEOUT } from "./env.ts";

export type MessageMatch = {
  authorKind?: ThreadMessage["authorKind"] | readonly ThreadMessage["authorKind"][];
  kind?: ThreadMessage["kind"] | readonly ThreadMessage["kind"][];
  /** 本文に含む文字列 */
  text?: string;
  instructionId?: string;
  /** この seq より後だけ（同じ文の古い発言と取り違えないため） */
  afterSeq?: number;
  /** 既定は complete（ストリーミング中・失敗は数えない）。null で状態を問わない */
  status?: ThreadMessage["status"] | null;
};

export function matchMessage(m: ThreadMessage, want: MessageMatch): boolean {
  const oneOf = <T>(v: T, w: T | readonly T[] | undefined) => w === undefined || (Array.isArray(w) ? w.includes(v) : v === w);
  if (!oneOf(m.authorKind, want.authorKind)) return false;
  if (!oneOf(m.kind, want.kind)) return false;
  if (want.text !== undefined && !m.body.includes(want.text)) return false;
  if (want.instructionId !== undefined && m.instructionId !== want.instructionId) return false;
  if (want.afterSeq !== undefined && m.seq <= want.afterSeq) return false;
  const status = want.status === undefined ? "complete" : want.status;
  if (status !== null && m.status !== status) return false;
  return true;
}

export class BatonApi {
  private csrfToken: string | null = null;
  readonly request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  // ───────────── 共通 ─────────────

  async session(): Promise<SessionInfo> {
    // CI の起動直後は、vite preview から workerd への接続が一瞬切れて 500（fetch failed）になることがある。
    // GET は何度送っても同じなので、5xx のときだけ少し待って送り直す
    let res = await this.request.get(API_PATHS.session);
    for (let i = 0; i < 5 && res.status() >= 500; i++) {
      await sleep(1_000);
      res = await this.request.get(API_PATHS.session);
    }
    await expectOk(res, "GET /api/session");
    const body = (await res.json()) as SessionInfo;
    this.csrfToken = body.csrfToken;
    return body;
  }

  /** 状態を変える呼び出し用のヘッダ（CSRF と Origin。v1 設計書 6.3） */
  async mutationHeaders(): Promise<Record<string, string>> {
    if (this.csrfToken === null) await this.session();
    return { [CSRF_HEADER]: this.csrfToken ?? "", Origin: BASE_URL };
  }

  private async getJson<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const res = await this.request.get(path, params ? { params } : undefined);
    await expectOk(res, `GET ${path}`);
    return (await res.json()) as T;
  }

  private async send<T>(method: "POST" | "PATCH" | "DELETE", path: string, data?: unknown): Promise<T> {
    const res = await this.request.fetch(path, { method, headers: await this.mutationHeaders(), ...(data === undefined ? {} : { data }) });
    await expectOk(res, `${method} ${path}`);
    if (res.status() === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ───────────── 会話（12.2） ─────────────

  async threads(): Promise<ThreadSummary[]> {
    return (await this.getJson<{ items: ThreadSummary[] }>(API_PATHS.threads)).items;
  }

  async thread(id: string): Promise<ThreadSummary> {
    const t = (await this.threads()).find((x) => x.id === id);
    if (!t) throw new Error(`スレッド ${id} がありません`);
    return t;
  }

  async cooThread(): Promise<ThreadSummary> {
    return this.thread(COO_THREAD_ID);
  }

  /** プロジェクトのリーダーのスレッド */
  async leaderThread(projectId: string): Promise<ThreadSummary> {
    let found: ThreadSummary | undefined;
    await expect
      .poll(async () => {
        found = (await this.threads()).find((t) => t.kind === "leader" && t.projectId === projectId);
        return found !== undefined;
      }, { message: `プロジェクト ${projectId} のリーダーのスレッド`, timeout: 15_000 })
      .toBe(true);
    return found!;
  }

  /** 最新 100 件（古い順） */
  async messages(threadId: string, opts: { before?: number; limit?: number } = {}): Promise<ThreadMessage[]> {
    const params: Record<string, number> = {};
    if (opts.before !== undefined) params.before = opts.before;
    if (opts.limit !== undefined) params.limit = opts.limit;
    const out = await this.getJson<ListMessagesOutput>(API_PATHS.threadMessages(threadId), params);
    return [...out.items].sort((a, b) => a.seq - b.seq);
  }

  /** いまの最後の seq（「ここから後」の起点。シナリオを何度回しても古い発言と取り違えないため） */
  async lastSeq(threadId: string): Promise<number> {
    const items = await this.messages(threadId, { limit: 1 });
    return items.length ? Math.max(...items.map((m) => m.seq)) : 0;
  }

  /** CEO の発言（12.2）。clientId は毎回新しく作る */
  async postMessage(threadId: string, body: string, opts: { contextProjectId?: string; instructionId?: string } = {}): Promise<ThreadMessage> {
    const out = await this.send<{ message: ThreadMessage }>("POST", API_PATHS.threadMessages(threadId), {
      clientId: crypto.randomUUID(),
      body,
      ...opts,
    });
    return out.message;
  }

  /** COO に話しかける */
  async sayToCoo(body: string, opts: { contextProjectId?: string } = {}): Promise<ThreadMessage> {
    return this.postMessage(COO_THREAD_ID, body, opts);
  }

  async findMessages(threadId: string, want: MessageMatch): Promise<ThreadMessage[]> {
    return (await this.messages(threadId)).filter((m) => matchMessage(m, want));
  }

  /** 条件に合う発言が現れるまで待つ（最初に見つかったもの） */
  async waitForMessage(threadId: string, want: MessageMatch, timeout = RUNNER_TIMEOUT): Promise<ThreadMessage> {
    let found: ThreadMessage | undefined;
    await expect
      .poll(
        async () => {
          found = (await this.findMessages(threadId, want))[0];
          return found !== undefined;
        },
        { message: `スレッド ${threadId} に ${JSON.stringify(want)} の発言`, timeout, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    return found!;
  }

  async markRead(threadId: string, seq: number): Promise<void> {
    await this.send("POST", API_PATHS.threadRead(threadId), { seq });
  }

  async leaveThread(threadId: string): Promise<void> {
    await this.send("POST", API_PATHS.threadLeave(threadId));
  }

  async acceptProposal(id: string, workspace?: AcceptProposalInput["workspace"]): Promise<AcceptProposalOutput> {
    return this.send<AcceptProposalOutput>("POST", API_PATHS.proposalAccept(id), workspace ? { workspace } : {});
  }

  // ───────────── 指示 ─────────────

  async list(view: "active" | "archived" = "active", projectId?: string): Promise<InstructionSummary[]> {
    const items: InstructionSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page++) {
      const params: Record<string, string> = { view };
      if (projectId) params.projectId = projectId;
      if (cursor) params.cursor = cursor;
      const body = await this.getJson<ListInstructionsOutput>(API_PATHS.instructions, params);
      items.push(...body.items);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  async detail(id: string): Promise<InstructionDetail> {
    return this.getJson<InstructionDetail>(API_PATHS.instruction(id));
  }

  async status(id: string): Promise<InstructionStatus> {
    return (await this.detail(id)).instruction.status;
  }

  async transition(id: string, action: CeoAction, expectedStatus: InstructionStatus, comment?: string): Promise<TransitionOutput> {
    return this.send<TransitionOutput>(
      "POST",
      API_PATHS.instructionTransition(id),
      comment === undefined ? { action, expectedStatus } : { action, expectedStatus, comment },
    );
  }

  async answerDecision(id: string, input: AnswerDecisionInput): Promise<AnswerDecisionOutput> {
    return this.send<AnswerDecisionOutput>("POST", API_PATHS.decisionAnswer(id), input);
  }

  /** 本文か件名に marker を含む指示（COO の delegate の brief に CEO の発言が入る前提。15.2） */
  async findByMarker(marker: string, view: "active" | "archived" = "active", timeout = RUNNER_TIMEOUT): Promise<InstructionSummary> {
    let found: InstructionSummary | undefined;
    await expect
      .poll(
        async () => {
          found = (await this.list(view)).find((i) => i.body.includes(marker) || (i.title ?? "").includes(marker));
          return found !== undefined;
        },
        { message: `本文に ${marker} を含む指示`, timeout, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    return found!;
  }

  /** サーバー側の状態が want のどれかになるまで待つ */
  async waitForStatus(
    id: string,
    want: InstructionStatus | readonly InstructionStatus[],
    timeout = RUNNER_TIMEOUT,
  ): Promise<InstructionDetail> {
    const wants: readonly InstructionStatus[] = typeof want === "string" ? [want] : want;
    let last: InstructionDetail | undefined;
    await expect
      .poll(
        async () => {
          last = await this.detail(id);
          return last.instruction.status;
        },
        { message: `指示 ${id} が ${wants.join("|")} になる`, timeout, intervals: [250, 500, 1000] },
      )
      .toMatch(new RegExp(`^(${wants.join("|")})$`));
    return last!;
  }

  /** 詳細が条件を満たすまで待つ */
  async waitForDetail(id: string, pred: (d: InstructionDetail) => boolean, message: string, timeout = RUNNER_TIMEOUT): Promise<InstructionDetail> {
    let last: InstructionDetail | undefined;
    await expect
      .poll(
        async () => {
          last = await this.detail(id);
          return pred(last);
        },
        { message, timeout, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    return last!;
  }

  /**
   * 会話から指示を作る（15.3 の createInstructionViaChat）。マーカーの無い依頼は、偽 COO が即 delegate して
   * Baton 専用のプロジェクト「テスト」に指示ができる（15.2）。text に [slow] などの台本のマーカーを入れられる。
   */
  async createInstructionViaChat(marker: string, text: string): Promise<InstructionSummary> {
    await this.sayToCoo(`${marker} ${text}`);
    return this.findByMarker(marker);
  }

  /** 会話から指示を作り、want（既定 review）まで待つ */
  async createAndWait(marker: string, text: string, want: InstructionStatus | readonly InstructionStatus[] = "review"): Promise<InstructionDetail> {
    const created = await this.createInstructionViaChat(marker, text);
    return this.waitForStatus(created.id, want);
  }

  /** 開いている承認（判断）が出るまで待つ */
  async waitForOpenDecision(id: string, kind?: "approval" | "interrupted", timeout = RUNNER_TIMEOUT): Promise<InstructionDetail["openDecisions"][number]> {
    const d = await this.waitForDetail(
      id,
      (d) => d.openDecisions.some((x) => kind === undefined || x.kind === kind),
      `指示 ${id} に開いた判断${kind ? `（${kind}）` : ""}`,
      timeout,
    );
    return d.openDecisions.find((x) => kind === undefined || x.kind === kind)!;
  }

  // ───────────── セッション ─────────────

  async transcript(sessionId: string, opts: { instructionId?: string; after?: number; limit?: number } = {}): Promise<TranscriptItem[]> {
    const params: Record<string, string | number> = {};
    if (opts.instructionId) params.instructionId = opts.instructionId;
    if (opts.after !== undefined) params.after = opts.after;
    if (opts.limit !== undefined) params.limit = opts.limit;
    return (await this.getJson<TranscriptOutput>(API_PATHS.sessionTranscript(sessionId), params)).items;
  }

  // ───────────── 組織・プロジェクト ─────────────

  async org(): Promise<OrgSnapshot> {
    return this.getJson<OrgSnapshot>(API_PATHS.org);
  }

  async sidebar(): Promise<SidebarOutput> {
    return this.getJson<SidebarOutput>(API_PATHS.projectsSidebar);
  }

  async projects(): Promise<ProjectWithTeam[]> {
    return (await this.getJson<{ items: ProjectWithTeam[] }>(API_PATHS.projects)).items;
  }

  async project(id: string): Promise<ProjectWithTeam> {
    const p = (await this.projects()).find((x) => x.id === id);
    if (!p) throw new Error(`プロジェクト ${id} がありません`);
    return p;
  }

  async repos(): Promise<RepoCandidate[]> {
    return (await this.getJson<{ items: RepoCandidate[] }>(API_PATHS.repos)).items;
  }

  async profiles(): Promise<ProfileView[]> {
    return (await this.getJson<{ items: ProfileView[] }>(API_PATHS.profiles)).items;
  }

  async quota(): Promise<QuotaOutput> {
    return this.getJson<QuotaOutput>(API_PATHS.quota);
  }

  // ───────────── 通知・秘書 ─────────────

  async pushSubscriptions(): Promise<PushSubscriptionView[]> {
    return (await this.getJson<{ items: PushSubscriptionView[] }>(API_PATHS.pushSubscriptions)).items;
  }

  async deletePushSubscription(id: string): Promise<void> {
    await this.send("DELETE", API_PATHS.pushSubscription(id));
  }

  async createBotToken(name: string, scopes: BotScope[]): Promise<CreateBotTokenOutput> {
    return this.send<CreateBotTokenOutput>("POST", API_PATHS.botTokens, { name, scopes });
  }

  async botTokens(): Promise<BotTokenView[]> {
    return (await this.getJson<{ items: BotTokenView[] }>(API_PATHS.botTokens)).items;
  }

  async revokeBotToken(id: string): Promise<void> {
    await this.send("DELETE", API_PATHS.botToken(id));
  }
}

export async function expectOk(res: APIResponse, what: string): Promise<void> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} が ${res.status()} を返した: ${text.slice(0, 500)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
