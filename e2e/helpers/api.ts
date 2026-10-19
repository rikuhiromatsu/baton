// ブラウザ用 API（設計書 4.2）を E2E から直接呼ぶ薄いクライアント。
// 前提づくり（review の指示を用意する等）と、画面の結果をサーバー側でも確かめるために使う。
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import {
  API_PATHS,
  CSRF_HEADER,
  type CeoAction,
  type InstructionDetail,
  type InstructionStatus,
  type InstructionSummary,
  type ListInstructionsOutput,
  type SessionInfo,
  type TransitionOutput,
} from "@baton/shared";
import { BASE_URL, RUNNER_TIMEOUT } from "./env.ts";

export class BatonApi {
  private csrfToken: string | null = null;
  private readonly request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  async session(): Promise<SessionInfo> {
    const res = await this.request.get(API_PATHS.session);
    await expectOk(res, "GET /api/session");
    const body = (await res.json()) as SessionInfo;
    this.csrfToken = body.csrfToken;
    return body;
  }

  /** 状態を変える呼び出し用のヘッダ（CSRF と Origin。設計書 6.3） */
  private async mutationHeaders(): Promise<Record<string, string>> {
    if (this.csrfToken === null) await this.session();
    return { [CSRF_HEADER]: this.csrfToken ?? "", Origin: BASE_URL };
  }

  async createInstruction(body: string): Promise<InstructionSummary> {
    const res = await this.request.post(API_PATHS.instructions, {
      headers: await this.mutationHeaders(),
      data: { clientId: crypto.randomUUID(), body },
    });
    await expectOk(res, "POST /api/instructions");
    return (await res.json()) as InstructionSummary;
  }

  async list(view: "active" | "archived" = "active"): Promise<InstructionSummary[]> {
    const items: InstructionSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page++) {
      const params: Record<string, string> = { view };
      if (cursor) params.cursor = cursor;
      const res = await this.request.get(API_PATHS.instructions, { params });
      await expectOk(res, "GET /api/instructions");
      const body = (await res.json()) as ListInstructionsOutput;
      items.push(...body.items);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  async detail(id: string): Promise<InstructionDetail> {
    const res = await this.request.get(API_PATHS.instruction(id));
    await expectOk(res, `GET /api/instructions/${id}`);
    return (await res.json()) as InstructionDetail;
  }

  async status(id: string): Promise<InstructionStatus> {
    return (await this.detail(id)).instruction.status;
  }

  async transition(id: string, action: CeoAction, expectedStatus: InstructionStatus, comment?: string): Promise<TransitionOutput> {
    const res = await this.request.post(API_PATHS.instructionTransition(id), {
      headers: await this.mutationHeaders(),
      data: comment === undefined ? { action, expectedStatus } : { action, expectedStatus, comment },
    });
    await expectOk(res, `POST transition ${action}`);
    return (await res.json()) as TransitionOutput;
  }

  /** 本文に marker を含む指示を探す（画面から送った指示の ID を知るため） */
  async findByMarker(marker: string, view: "active" | "archived" = "active"): Promise<InstructionSummary> {
    let found: InstructionSummary | undefined;
    await expect
      .poll(
        async () => {
          found = (await this.list(view)).find((i) => i.body.includes(marker));
          return found !== undefined;
        },
        { message: `本文に ${marker} を含む指示`, timeout: 15_000 },
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

  /** 指示を作り、ランナーが処理して review になるまで待つ */
  async createAndWait(body: string, want: InstructionStatus | readonly InstructionStatus[] = "review"): Promise<InstructionDetail> {
    const created = await this.createInstruction(body);
    return this.waitForStatus(created.id, want);
  }
}

export async function expectOk(res: APIResponse, what: string): Promise<void> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} が ${res.status()} を返した: ${text.slice(0, 500)}`);
  }
}
