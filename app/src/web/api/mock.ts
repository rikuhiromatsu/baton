// モックのバックエンド（?mock=1 のときだけ main.tsx が動的 import する）。
// メモリ上のデータと擬似 WebSocket で、U1（Worker）が無くても全画面が動くようにする。
import {
  API_PATHS,
  LIMITS,
  nextStatus,
  type AgentEvent,
  type AgentEventKind,
  type Artifact,
  type CeoAction,
  type Decision,
  type InstructionDetail,
  type InstructionStatus,
  type InstructionSummary,
  type ProjectWithTeam,
  type RunnerStatus,
  type ServerEvent,
  type SessionInfo,
  type Task,
  type UsageToday,
} from "@baton/shared";
import type { SocketLike } from "./ws.ts";

type Rec = {
  summary: InstructionSummary;
  feedback: string | null;
  tokensIn: number;
  tokensOut: number;
  attempt: number;
  archivedFrom: InstructionStatus | null;
  tasks: Task[];
  decisions: Decision[];
  artifacts: Artifact[];
  events: AgentEvent[];
};

type TransitionLog = { id: string; instructionId: string; from: InstructionStatus; to: InstructionStatus; at: number; undone: boolean; action: CeoAction };

export type MockOptions = {
  /** 未ログインから始める */
  loggedOut?: boolean;
  /** シミュレーションの速さ（1 = 標準。テストでは大きくする） */
  speed?: number;
  /** 種データを入れない */
  empty?: boolean;
  /** 一覧の応答を遅らせる（スケルトンの確認用。ミリ秒） */
  listDelayMs?: number;
  now?: () => number;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function uuid(): string {
  return crypto.randomUUID();
}

function json(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

export class MockBackend {
  readonly recs = new Map<string, Rec>();
  readonly projects: ProjectWithTeam[] = [];
  readonly transitions: TransitionLog[] = [];
  readonly sockets = new Set<MockSocket>();
  loggedIn: boolean;
  csrf = uuid();
  runner: RunnerStatus;
  usage: UsageToday;
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private globalTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly speed: number;
  private readonly listDelayMs: number;
  private readonly now: () => number;

  constructor(opts: MockOptions = {}) {
    this.loggedIn = !opts.loggedOut;
    this.speed = opts.speed ?? 1;
    this.listDelayMs = opts.listDelayMs ?? 0;
    this.now = opts.now ?? (() => Date.now());
    const now = this.now();
    this.runner = {
      online: true,
      lastHeartbeatAt: now - 12_000,
      activeInstructionIds: [],
      version: "0.1.0",
      tailnetUrl: "https://rikumac-mini.mock.ts.net",
    };
    this.usage = {
      day: new Date(now).toISOString().slice(0, 10),
      tokensIn: 412_300,
      tokensOut: 96_400,
      byModel: [
        { model: "@cf/openai/gpt-oss-120b", tokensIn: 120_000, tokensOut: 31_000 },
        { model: "@cf/zai-org/glm-4.7-flash", tokensIn: 292_300, tokensOut: 65_400 },
      ],
      quotaHitAt: null,
      dailyTokenLimit: LIMITS.tokensPerDay,
    };
    if (!opts.empty) this.seed();
  }

  dispose(): void {
    for (const list of this.timers.values()) list.forEach(clearTimeout);
    this.timers.clear();
    this.globalTimers.forEach(clearTimeout);
    this.globalTimers = [];
    for (const s of this.sockets) s.close();
  }

  /** 画面に出る可能性がある文字列を全部まとめたもの（F7 で「AI が書いた文章」として扱う） */
  dynamicTextDump(): string {
    const all = { recs: [...this.recs.values()], projects: this.projects, runner: this.runner, usage: this.usage };
    const leaves: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") leaves.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(all);
    return `${leaves.join("\n\u0000\n")}\n\u0000\n${JSON.stringify(all)}`;
  }

  login(): void {
    this.loggedIn = true;
  }

  // ───────────── 種データ ─────────────

  private seed(): void {
    const now = this.now();
    const research = this.addProject("research", "リサーチ", "市場・競合・技術の下調べと比較表づくり", "リサ", "調べものと要点整理", [
      ["ミナ", "Web の一次情報を集める"],
      ["ケイ", "比較表と要約を書く"],
    ]);
    const docs = this.addProject("docs", "資料作成", "定例・提案・社内向けの資料のたたき台", "フミ", "構成と論点の整理", [
      ["アオ", "スライドの文章"],
      ["ユウ", "数字と図表"],
      ["ハル", "校正"],
    ]);
    const marketing = this.addProject("marketing", "マーケティング", "LP・告知文・SNS 投稿の文案", "メイ", "訴求の設計", [
      ["ソラ", "コピーライティング"],
    ]);

    // 判断待ち
    const ask = this.addRec({
      body: "競合 3 社の料金プランを比較して、うちの新プランの価格案を出して",
      title: "競合 3 社の料金比較と価格案",
      status: "needs_decision",
      changedAgo: 4 * MIN,
      project: research,
    });
    this.addTasks(ask, research, [
      ["plan", "調査の計画", "done"],
      ["work", "3 社の公開料金を集める", "done"],
      ["work", "比較表にまとめる", "pending"],
    ]);
    const decision: Decision = {
      id: uuid(),
      instructionId: ask.summary.id,
      taskId: null,
      askedByAgentId: null,
      question: "比較の軸は「月額の総額」と「1 席あたりの単価」のどちらを優先しますか？",
      options: ["月額の総額", "1 席あたりの単価", "両方を並べる"],
      status: "open",
      answer: null,
      answeredAt: null,
      createdAt: now - 4 * MIN,
    };
    ask.decisions.push(decision);
    ask.summary.openDecisionId = decision.id;
    this.addEvents(ask, [
      ["llm_call", { stage: "coo_route", model: "@cf/openai/gpt-oss-120b" }],
      ["action", { stage: "route", kind: "route", title: ask.summary.title }],
      ["decision", { question: decision.question }],
    ]);

    // 確認
    const review = this.addRec({
      body: "来週の定例の資料のたたき台を作って。先月の数字と、今月やったこと 3 つ",
      title: "来週の定例資料のたたき台",
      status: "review",
      changedAgo: 18 * MIN,
      project: docs,
      result:
        "定例資料のたたき台を作りました（全 6 枚）。\n\n結論: 先月比で問い合わせ数は 1.4 倍、成約は横ばいです。今月の 3 つは「料金ページの改修」「導入事例 2 本の公開」「サポート窓口の一本化」です。\n\n成果物: slides/teirei.md（本文）、data/kpi.csv（数字）\n\n残課題: 成約率の内訳は元データが無いため「未確認」と書いています。",
    });
    this.addTasks(review, docs, [
      ["plan", "資料の構成を決める", "done"],
      ["work", "先月の数字をまとめる", "done"],
      ["work", "今月やったことを 3 つに絞る", "done"],
      ["work", "スライドの本文を書く", "done"],
      ["review", "全体を見直す", "done"],
    ]);
    this.addArtifact(review, docs, "slides/teirei.md", "定例資料の本文", "# 定例（10 月第 4 週）\n\n## 1. 先月の数字\n- 問い合わせ: 128 件（前月 91 件）\n- 成約: 9 件（前月 9 件）\n\n## 2. 今月やったこと\n1. 料金ページの改修\n2. 導入事例 2 本の公開\n3. サポート窓口の一本化\n");
    this.addArtifact(review, docs, "data/kpi.csv", "数字の元データ", "month,inquiries,deals\n2026-08,91,9\n2026-09,128,9\n");
    this.addEvents(review, [
      ["llm_call", { stage: "coo_route", model: "@cf/openai/gpt-oss-120b" }],
      ["action", { stage: "route", kind: "route", title: review.summary.title }],
      ["tool_call", { tool: "fs_write", args: { path: "slides/teirei.md" } }],
      ["tool_result", { ok: true, bytes: 1824 }],
      ["summary", { text: "スライドの本文を 6 枚分書きました" }],
    ]);

    // 実行中（このあと自動で確認まで進む）
    const running = this.addRec({
      body: "新しい LP のキャッチコピー案を 3 つ。トーンは落ち着いた感じで",
      title: "LP のキャッチコピー案 3 つ",
      status: "running",
      changedAgo: 2 * MIN,
      project: marketing,
    });
    this.addTasks(running, marketing, [
      ["plan", "訴求の軸を決める", "done"],
      ["work", "案を 3 つ書く", "running"],
      ["work", "言い回しを整える", "pending"],
    ]);
    this.addEvents(running, [
      ["llm_call", { stage: "coo_route", model: "@cf/openai/gpt-oss-120b" }],
      ["action", { stage: "route", kind: "route", title: running.summary.title }],
      ["tool_call", { tool: "fs_read", args: { path: "brief.md" } }],
    ]);
    this.runner.activeInstructionIds = [running.summary.id];

    // 待機
    const queued = this.addRec({
      body: "請求書のテンプレートを今の会社名と口座に合わせて直しておいて",
      title: null,
      status: "queued",
      changedAgo: 1 * MIN,
      project: null,
    });

    // 失敗
    const failed = this.addRec({
      body: "過去 2 年分の議事録から決定事項だけを抜き出して一覧に",
      title: "議事録から決定事項を抜き出す",
      status: "failed",
      changedAgo: 3 * HOUR,
      project: research,
    });
    failed.summary.error = "上限: 1 指示あたりの AI 呼び出し 60 回";
    this.addTasks(failed, research, [
      ["plan", "対象の議事録を洗い出す", "done"],
      ["work", "2024 年分を読む", "done"],
      ["work", "2025 年分を読む", "failed"],
    ]);

    // 取消
    this.addRec({ body: "週末の社内イベントの案内文", title: "社内イベントの案内文", status: "canceled", changedAgo: 2 * DAY, project: marketing });

    // 完了（直近と 10 日前。10 日前のものはホームに出ない）
    const done1 = this.addRec({
      body: "採用ページの募集要項を読みやすく直して",
      title: "募集要項の書き直し",
      status: "done",
      changedAgo: 1 * DAY,
      project: docs,
      result: "募集要項を 3 段落に整理しました。必須条件と歓迎条件を分け、勤務形態を先頭に移しています。",
    });
    this.addTasks(done1, docs, [
      ["plan", "直す方針を決める", "done"],
      ["work", "本文を書き直す", "done"],
      ["review", "見直し", "done"],
    ]);
    this.addRec({ body: "取引先 5 社の住所録を CSV に", title: "取引先の住所録 CSV", status: "done", changedAgo: 3 * DAY, project: research, result: "5 社分の住所録を CSV にしました。" });
    this.addRec({ body: "古い依頼", title: "9 月の売上メモ", status: "done", changedAgo: 10 * DAY, project: docs, result: "9 月の売上をまとめました。" });

    // アーカイブ
    const a1 = this.addRec({ body: "8 月の経費の集計", title: "8 月の経費集計", status: "archived", changedAgo: 12 * DAY, project: docs, result: "8 月の経費を科目別に集計しました。" });
    a1.archivedFrom = "done";
    const a2 = this.addRec({ body: "ロゴの配色案", title: "ロゴの配色案", status: "archived", changedAgo: 20 * DAY, project: marketing });
    a2.archivedFrom = "canceled";

    // 実行中のものはそのまま進める、待機は少しして拾われる
    this.schedule(running.summary.id, 5_000, () => this.finishWork(running.summary.id));
    this.scheduleGlobal(25_000, () => {
      const q = this.recs.get(queued.summary.id);
      if (q && q.summary.status === "queued") this.startRun(q.summary.id);
    });
  }

  private addProject(slug: string, name: string, summary: string, leader: string, leaderSpec: string, members: [string, string][]): ProjectWithTeam {
    const id = uuid();
    const p: ProjectWithTeam = {
      id,
      slug,
      name,
      summary,
      status: "active",
      updatedAt: this.now() - 2 * DAY,
      agents: [
        { id: uuid(), projectId: id, role: "leader", name: leader, specialty: leaderSpec, model: null, active: true },
        ...members.map(([n, s]) => ({ id: uuid(), projectId: id, role: "member" as const, name: n, specialty: s, model: null, active: true })),
      ],
    };
    this.projects.push(p);
    return p;
  }

  private addRec(o: {
    body: string;
    title: string | null;
    status: InstructionStatus;
    changedAgo: number;
    project: ProjectWithTeam | null;
    result?: string;
  }): Rec {
    const now = this.now();
    const id = uuid();
    const changed = now - o.changedAgo;
    const rec: Rec = {
      summary: {
        id,
        clientId: uuid(),
        body: o.body,
        title: o.title,
        status: o.status,
        statusChangedAt: changed,
        projectId: o.project?.id ?? null,
        projectName: o.project?.name ?? null,
        resultSummary: o.result ?? null,
        openDecisionId: null,
        notBefore: null,
        error: null,
        taskCounts: { total: 0, done: 0, running: 0, failed: 0 },
        createdAt: changed - 6 * MIN,
        updatedAt: changed,
        completedAt: o.status === "done" ? changed : null,
      },
      feedback: null,
      tokensIn: 18_400,
      tokensOut: 4_200,
      attempt: 1,
      archivedFrom: null,
      tasks: [],
      decisions: [],
      artifacts: [],
      events: [],
    };
    this.recs.set(id, rec);
    return rec;
  }

  private addTasks(rec: Rec, project: ProjectWithTeam, specs: [Task["kind"], string, Task["status"]][]): void {
    const leader = project.agents.find((a) => a.role === "leader");
    const members = project.agents.filter((a) => a.role === "member");
    let planId: string | null = null;
    let workIndex = 0;
    specs.forEach(([kind, title, status], i) => {
      const id = uuid();
      const assignee = kind === "work" ? members[workIndex++ % members.length] : leader;
      const t: Task = {
        id,
        instructionId: rec.summary.id,
        parentTaskId: kind === "plan" ? null : planId,
        assigneeAgentId: assignee?.id ?? null,
        kind,
        planKey: kind === "work" ? `t${workIndex}` : null,
        dependsOn: [],
        title,
        spec: `${title}。完了の条件を満たしたらファイルに書き出す。`,
        status,
        resultSummary: status === "done" ? `${title}を終えました。` : status === "failed" ? "途中で上限に達しました。" : null,
        round: 1,
        seq: i,
        startedAt: status === "pending" ? null : rec.summary.createdAt + i * MIN,
        finishedAt: status === "done" || status === "failed" ? rec.summary.createdAt + (i + 1) * MIN : null,
        updatedAt: rec.summary.updatedAt,
      };
      if (kind === "plan") planId = id;
      rec.tasks.push(t);
    });
    rec.summary.taskCounts = this.counts(rec);
  }

  private addArtifact(rec: Rec, project: ProjectWithTeam, relPath: string, title: string, preview: string): Artifact {
    const a: Artifact = {
      id: uuid(),
      instructionId: rec.summary.id,
      taskId: rec.tasks.find((t) => t.kind === "work")?.id ?? null,
      projectSlug: project.slug,
      relPath,
      title,
      mime: relPath.endsWith(".csv") ? "text/csv" : "text/markdown",
      sizeBytes: new TextEncoder().encode(preview).length,
      createdAt: rec.summary.updatedAt,
      sha256: "0".repeat(64),
      previewText: preview,
    };
    rec.artifacts.push(a);
    return a;
  }

  private addEvents(rec: Rec, list: [AgentEventKind, unknown][]): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const [kind, content] of list) {
      const ev: AgentEvent = {
        id: uuid(),
        instructionId: rec.summary.id,
        taskId: null,
        agentId: null,
        seq: rec.events.length,
        kind,
        content,
        model: kind === "llm_call" ? "@cf/zai-org/glm-4.7-flash" : null,
        tokensIn: kind === "llm_call" ? 1200 : null,
        tokensOut: kind === "llm_call" ? 240 : null,
        durationMs: kind === "llm_call" ? 1800 : null,
        createdAt: this.now(),
      };
      rec.events.push(ev);
      out.push(ev);
    }
    return out;
  }

  private counts(rec: Rec): InstructionSummary["taskCounts"] {
    const work = rec.tasks.filter((t) => t.kind === "work");
    return {
      total: work.length,
      done: work.filter((t) => t.status === "done").length,
      running: work.filter((t) => t.status === "running").length,
      failed: work.filter((t) => t.status === "failed").length,
    };
  }

  private detail(rec: Rec): InstructionDetail {
    return {
      instruction: { ...rec.summary, feedback: rec.feedback, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut, attempt: rec.attempt },
      project: this.projects.find((p) => p.id === rec.summary.projectId) ?? null,
      tasks: rec.tasks,
      decisions: rec.decisions,
      artifacts: rec.artifacts.map(({ sha256: _s, previewText: _p, ...meta }) => meta),
      lastEventSeq: rec.events.length - 1,
    };
  }

  // ───────────── 配信 ─────────────

  private broadcast(ev: ServerEvent): void {
    for (const s of this.sockets) {
      if (ev.t === "agent_event.appended" && s.subscribedId !== ev.event.instructionId) continue;
      s.deliver(ev);
    }
  }

  private touch(rec: Rec, patch: Partial<InstructionSummary>): void {
    const now = Math.max(this.now(), rec.summary.updatedAt + 1);
    const statusChanged = patch.status !== undefined && patch.status !== rec.summary.status;
    rec.summary = {
      ...rec.summary,
      ...patch,
      updatedAt: now,
      statusChangedAt: statusChanged ? now : rec.summary.statusChangedAt,
      completedAt: patch.status === "done" ? now : patch.status && patch.status !== "archived" ? null : rec.summary.completedAt,
    };
    this.broadcast({ t: "instruction.upserted", instruction: rec.summary });
  }

  private emitEvents(rec: Rec, list: [AgentEventKind, unknown][]): void {
    for (const ev of this.addEvents(rec, list)) this.broadcast({ t: "agent_event.appended", event: ev });
    this.usage = {
      ...this.usage,
      tokensIn: this.usage.tokensIn + 1200 * list.length,
      tokensOut: this.usage.tokensOut + 240 * list.length,
    };
    this.broadcast({ t: "usage.updated", usage: this.usage });
  }

  private setTask(rec: Rec, task: Task, patch: Partial<Task>): void {
    Object.assign(task, patch, { updatedAt: this.now() });
    this.broadcast({ t: "task.upserted", task: { ...task } });
    rec.summary.taskCounts = this.counts(rec);
  }

  private newTask(rec: Rec, kind: Task["kind"], title: string, parent: string | null, assignee: string | null): Task {
    const t: Task = {
      id: uuid(),
      instructionId: rec.summary.id,
      parentTaskId: parent,
      assigneeAgentId: assignee,
      kind,
      planKey: kind === "work" ? `t${rec.tasks.filter((x) => x.kind === "work").length + 1}` : null,
      dependsOn: [],
      title,
      spec: title,
      status: "pending",
      resultSummary: null,
      round: 1,
      seq: rec.tasks.length,
      startedAt: null,
      finishedAt: null,
      updatedAt: this.now(),
    };
    rec.tasks.push(t);
    this.broadcast({ t: "task.upserted", task: { ...t } });
    return t;
  }

  private setRunnerActive(): void {
    const active = [...this.recs.values()].filter((r) => r.summary.status === "running").map((r) => r.summary.id);
    this.runner = { ...this.runner, activeInstructionIds: active, lastHeartbeatAt: this.now() };
    this.broadcast({ t: "runner.status", runner: this.runner });
  }

  // ───────────── シミュレーション ─────────────

  private schedule(id: string, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      const list = this.timers.get(id);
      if (list) this.timers.set(id, list.filter((x) => x !== t));
      fn();
    }, ms / this.speed);
    const list = this.timers.get(id) ?? [];
    list.push(t);
    this.timers.set(id, list);
  }

  private scheduleGlobal(ms: number, fn: () => void): void {
    this.globalTimers.push(setTimeout(fn, ms / this.speed));
  }

  private stopRun(id: string): void {
    this.timers.get(id)?.forEach(clearTimeout);
    this.timers.delete(id);
  }

  /** queued → running → (判断待ち) → review / failed */
  startRun(id: string): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    this.stopRun(id);
    this.schedule(id, 1200, () => {
      if (rec.summary.status !== "queued") return;
      const body = rec.summary.body;
      const project = this.projects.find((p) => p.id === rec.summary.projectId) ?? this.projects[0] ?? null;
      rec.attempt += 1;
      this.touch(rec, {
        status: "running",
        title: rec.summary.title ?? body.replace(/\s+/g, " ").slice(0, 20),
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        error: null,
      });
      this.setRunnerActive();
      this.emitEvents(rec, [
        ["llm_call", { stage: "coo_route", model: "@cf/openai/gpt-oss-120b" }],
        ["action", { stage: "route", kind: "route", title: rec.summary.title }],
      ]);

      const answered = rec.decisions.some((d) => d.status === "answered");
      if (body.includes("[ask]") && !answered) {
        this.schedule(id, 1500, () => this.askCeo(rec));
        return;
      }
      this.schedule(id, 1200, () => this.planAndWork(rec, project));
    });
  }

  private askCeo(rec: Rec): void {
    if (rec.summary.status !== "running") return;
    const d: Decision = {
      id: uuid(),
      instructionId: rec.summary.id,
      taskId: null,
      askedByAgentId: null,
      question: "進め方を選んでください。A案は早く粗く、B案は時間をかけて丁寧に進めます。",
      options: ["A案", "B案"],
      status: "open",
      answer: null,
      answeredAt: null,
      createdAt: this.now(),
    };
    rec.decisions.push(d);
    this.broadcast({ t: "decision.upserted", decision: d });
    this.emitEvents(rec, [["decision", { question: d.question }]]);
    this.touch(rec, { status: "needs_decision", openDecisionId: d.id });
    this.setRunnerActive();
  }

  private planAndWork(rec: Rec, project: ProjectWithTeam | null): void {
    if (rec.summary.status !== "running") return;
    const leader = project?.agents.find((a) => a.role === "leader") ?? null;
    const members = project?.agents.filter((a) => a.role === "member") ?? [];
    const plan = rec.tasks.find((t) => t.kind === "plan" && t.status === "done") ?? this.newTask(rec, "plan", "進め方を決める", null, leader?.id ?? null);
    if (plan.status !== "done") this.setTask(rec, plan, { status: "done", startedAt: this.now(), finishedAt: this.now(), resultSummary: "作業を 2 つに分けました。" });
    this.emitEvents(rec, [["llm_call", { stage: "leader_plan", model: "@cf/zai-org/glm-4.7-flash" }]]);
    const works = [
      this.newTask(rec, "work", "材料を集める", plan.id, members[0]?.id ?? null),
      this.newTask(rec, "work", "下書きを書く", plan.id, members[1]?.id ?? members[0]?.id ?? null),
    ];
    this.touch(rec, { taskCounts: this.counts(rec) });
    works.forEach((w) => this.setTask(rec, w, { status: "running", startedAt: this.now() }));
    this.touch(rec, { taskCounts: this.counts(rec) });
    const fail = rec.summary.body.includes("[fail]");
    this.schedule(rec.summary.id, 1500, () => {
      if (rec.summary.status !== "running") return;
      this.emitEvents(rec, [
        ["tool_call", { tool: "fs_write", args: { path: "notes/t1.md" } }],
        ["tool_result", { ok: true, bytes: 920 }],
      ]);
      this.setTask(rec, works[0]!, fail ? { status: "failed", finishedAt: this.now(), resultSummary: "必要な資料が見つかりませんでした。" } : { status: "done", finishedAt: this.now(), resultSummary: "材料を 5 件集めました。" });
      this.touch(rec, { taskCounts: this.counts(rec) });
      if (!fail && project) {
        const a = this.addArtifact(rec, project, "notes/t1.md", "集めた材料", "# 材料\n- 一次情報 3 件\n- 社内の過去資料 2 件\n");
        const { sha256: _s, previewText: _p, ...meta } = a;
        this.broadcast({ t: "artifact.created", artifact: meta });
      }
    });
    this.schedule(rec.summary.id, 2800, () => this.finishWork(rec.summary.id));
  }

  private finishWork(id: string): void {
    const rec = this.recs.get(id);
    if (!rec || rec.summary.status !== "running") return;
    const project = this.projects.find((p) => p.id === rec.summary.projectId) ?? null;
    const fail = rec.summary.body.includes("[fail]");
    for (const w of rec.tasks.filter((t) => t.kind === "work" && t.status !== "done" && t.status !== "failed")) {
      this.setTask(rec, w, fail ? { status: "failed", finishedAt: this.now() } : { status: "done", finishedAt: this.now(), resultSummary: "下書きを書きました。" });
    }
    this.touch(rec, { taskCounts: this.counts(rec) });
    if (fail) {
      this.emitEvents(rec, [["error", { message: "メンバーが作業をあきらめました" }]]);
      this.touch(rec, { status: "failed", error: "上限: メンバーの 1 タスクのターン 12 回" });
      this.setRunnerActive();
      return;
    }
    if (project && !rec.artifacts.some((a) => a.relPath === "notes/t2.md")) {
      const a = this.addArtifact(rec, project, "notes/t2.md", "下書き", "# 下書き\n\n落ち着いたトーンで 3 案:\n1. 仕事は、任せるほど速くなる。\n2. 指示ひとつで、チームが動く。\n3. あなたは決めるだけ。\n");
      const { sha256: _s, previewText: _p, ...meta } = a;
      this.broadcast({ t: "artifact.created", artifact: meta });
    }
    this.schedule(id, 1200, () => {
      if (rec.summary.status !== "running") return;
      const leader = project?.agents.find((a) => a.role === "leader") ?? null;
      const plan = rec.tasks.find((t) => t.kind === "plan");
      const review = this.newTask(rec, "review", "全体のまとめ", plan?.id ?? null, leader?.id ?? null);
      this.setTask(rec, review, { status: "done", startedAt: this.now(), finishedAt: this.now(), resultSummary: "要点をまとめました。" });
      this.emitEvents(rec, [
        ["llm_call", { stage: "leader_review", model: "@cf/zai-org/glm-4.7-flash" }],
        ["llm_call", { stage: "coo_final", model: "@cf/openai/gpt-oss-120b" }],
        ["summary", { text: "最終報告を書きました" }],
      ]);
      this.touch(rec, {
        status: "review",
        taskCounts: this.counts(rec),
        resultSummary: `ご依頼「${rec.summary.title ?? ""}」を終えました。\n\n結論: 下書きと材料をそろえました。成果物は notes/ にあります。\n\n残課題: 表現の最終確認をお願いします。`,
      });
      this.setRunnerActive();
    });
  }

  // ───────────── REST ─────────────

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    await new Promise((r) => setTimeout(r, 60 / this.speed));
    const url = new URL(input, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (path === API_PATHS.authLogout && method === "POST") {
      this.loggedIn = false;
      return json(204);
    }
    if (!this.loggedIn) return error(401, "unauthorized", "unauthorized");
    if (method !== "GET") {
      const headers = new Headers(init.headers);
      if (headers.get("X-Baton-CSRF") !== this.csrf) return error(403, "forbidden", "csrf");
    }

    if (path === API_PATHS.session) {
      const s: SessionInfo = {
        user: { id: "u1", email: "r.hiromatsu.work@gmail.com", name: "Riku Hiromatsu", pictureUrl: null },
        csrfToken: this.csrf,
        runner: this.runner,
        env: "development",
      };
      return json(200, s);
    }
    if (path === API_PATHS.instructions && method === "GET") {
      if (this.listDelayMs > 0) await new Promise((r) => setTimeout(r, this.listDelayMs));
      const view = url.searchParams.get("view") === "archived" ? "archived" : "active";
      const items = [...this.recs.values()]
        .map((r) => r.summary)
        .filter((s) => (view === "archived" ? s.status === "archived" : s.status !== "archived"))
        .sort((a, b) => b.statusChangedAt - a.statusChangedAt);
      return json(200, { items, nextCursor: null });
    }
    if (path === API_PATHS.instructions && method === "POST") {
      const clientId = String(body.clientId ?? "");
      const text = String(body.body ?? "").trim();
      if (!text || text.length > 8000) return error(400, "invalid", "invalid");
      const existing = [...this.recs.values()].find((r) => r.summary.clientId === clientId);
      if (existing) return json(200, existing.summary);
      const rec = this.addRec({ body: text, title: null, status: "queued", changedAgo: 0, project: null });
      rec.summary.clientId = clientId;
      rec.attempt = 0;
      rec.summary.updatedAt = this.now();
      this.broadcast({ t: "instruction.upserted", instruction: rec.summary });
      this.startRun(rec.summary.id);
      return json(201, rec.summary);
    }
    let m = path.match(/^\/api\/instructions\/([^/]+)$/);
    if (m && method === "GET") {
      const rec = this.recs.get(m[1]!);
      return rec ? json(200, this.detail(rec)) : error(404, "not_found", "not found");
    }
    m = path.match(/^\/api\/instructions\/([^/]+)\/events$/);
    if (m && method === "GET") {
      const rec = this.recs.get(m[1]!);
      if (!rec) return error(404, "not_found", "not found");
      const after = Number(url.searchParams.get("after") ?? -1);
      return json(200, { items: rec.events.filter((e) => e.seq > after).slice(0, 200) });
    }
    m = path.match(/^\/api\/instructions\/([^/]+)\/transition$/);
    if (m && method === "POST") return this.transition(m[1]!, body);
    m = path.match(/^\/api\/transitions\/([^/]+)\/undo$/);
    if (m && method === "POST") return this.undo(m[1]!);
    m = path.match(/^\/api\/decisions\/([^/]+)\/answer$/);
    if (m && method === "POST") return this.answer(m[1]!, body);
    if (path === API_PATHS.projects) return json(200, { items: this.projects });
    m = path.match(/^\/api\/artifacts\/([^/]+)$/);
    if (m) {
      for (const r of this.recs.values()) {
        const a = r.artifacts.find((x) => x.id === m![1]);
        if (a) return json(200, a);
      }
      return error(404, "not_found", "not found");
    }
    if (path === API_PATHS.usageToday) return json(200, this.usage);
    return error(404, "not_found", "not found");
  };

  private transition(id: string, body: Record<string, unknown>): Response {
    const rec = this.recs.get(id);
    if (!rec) return error(404, "not_found", "not found");
    const action = body.action as CeoAction;
    const expected = body.expectedStatus as InstructionStatus;
    if (rec.summary.status !== expected) return error(409, "conflict", "status changed");
    const from = rec.summary.status;
    const to = nextStatus(from, action, rec.archivedFrom ?? undefined);
    if (!to) return error(409, "conflict", "not allowed");
    if (to === "archived") rec.archivedFrom = from;
    if (action === "send_back") rec.feedback = typeof body.comment === "string" ? body.comment : null;
    if (action === "cancel") {
      this.stopRun(id);
      for (const d of rec.decisions) if (d.status === "open") {
        d.status = "canceled";
        this.broadcast({ t: "decision.upserted", decision: { ...d } });
      }
    }
    this.touch(rec, { status: to, openDecisionId: action === "cancel" ? null : rec.summary.openDecisionId });
    if (action === "cancel") this.setRunnerActive();
    const log: TransitionLog = { id: uuid(), instructionId: id, from, to, at: this.now(), undone: false, action };
    this.transitions.push(log);
    if (to === "queued") this.startRun(id);
    return json(200, { instruction: rec.summary, transitionId: log.id });
  }

  private undo(transitionId: string): Response {
    const log = this.transitions.find((t) => t.id === transitionId);
    if (!log || log.undone || this.now() - log.at > LIMITS.undoServerWindowMs) return error(409, "conflict", "cannot undo");
    const rec = this.recs.get(log.instructionId);
    if (!rec || rec.summary.status !== log.to) return error(409, "conflict", "cannot undo");
    log.undone = true;
    // cancel の取り消しは queued に戻す（3.5）
    const back: InstructionStatus = log.action === "cancel" ? "queued" : log.from;
    this.stopRun(rec.summary.id);
    this.touch(rec, { status: back });
    if (back === "queued") this.startRun(rec.summary.id);
    return json(200, { instruction: rec.summary });
  }

  private answer(decisionId: string, body: Record<string, unknown>): Response {
    for (const rec of this.recs.values()) {
      const d = rec.decisions.find((x) => x.id === decisionId);
      if (!d) continue;
      if (d.status !== "open") return error(409, "conflict", "already answered");
      const answer = String(body.answer ?? "").trim();
      if (!answer) return error(400, "invalid", "invalid");
      d.status = "answered";
      d.answer = answer;
      d.answeredAt = this.now();
      this.broadcast({ t: "decision.upserted", decision: { ...d } });
      this.touch(rec, { status: "queued", openDecisionId: null });
      this.startRun(rec.summary.id);
      return json(200, { decision: d, instruction: rec.summary });
    }
    return error(404, "not_found", "not found");
  }

  // ───────────── WebSocket ─────────────

  createSocket = (_url: string): SocketLike => {
    const s = new MockSocket(this);
    this.sockets.add(s);
    return s;
  };

  helloFor(): ServerEvent {
    return { t: "hello", serverTime: this.now(), runner: this.runner };
  }
}

export class MockSocket implements SocketLike {
  readyState = 0;
  subscribedId: string | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private readonly backend: MockBackend;

  constructor(backend: MockBackend) {
    this.backend = backend;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (!backend.loggedIn) {
        this.close();
        return;
      }
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.deliver(backend.helloFor());
    }, 30);
  }

  deliver(ev: ServerEvent): void {
    if (this.readyState !== 1) return;
    const data = JSON.stringify(ev);
    queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data })));
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    if (data === "ping") {
      queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: "pong" })));
      return;
    }
    try {
      const msg = JSON.parse(data) as { t: string; instructionId?: string };
      if (msg.t === "subscribe") this.subscribedId = msg.instructionId ?? null;
      if (msg.t === "unsubscribe") this.subscribedId = null;
    } catch {
      // 無視
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.backend.sockets.delete(this);
    this.onclose?.(new CloseEvent("close"));
  }
}

/** 生ログ（SSE）の代わり。数百 ms ごとに行を流す */
export function mockRawLog(_url: string, onLine: (line: string) => void): { close(): void } {
  const lines = [
    "[runner] claim ok attempt=1",
    "[coo] route -> project=research",
    "[leader] plan tasks=2",
    "[member:t1] tool fs_list path=.",
    "[member:t1] tool fs_write path=notes/t1.md bytes=920",
    "[member:t2] tool fs_read path=notes/t1.md",
    "[member:t2] done artifacts=1",
    "[leader] report",
    "[coo] final",
  ];
  let i = 0;
  const timer = setInterval(() => {
    onLine(`${new Date().toISOString().slice(11, 19)} ${lines[i % lines.length]}`);
    i += 1;
  }, 600);
  return { close: () => clearInterval(timer) };
}
