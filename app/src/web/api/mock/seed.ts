// モックの種データ。台本（script.ts）を早送りで再生して「途中まで進んだ状態」を作る
import { COO_THREAD_ID, type ProfileView, type ThreadMessage } from "@baton/shared";
import { COO_AUTHOR, uuid, type MockBackend } from "./backend.ts";
import type { Flows } from "./script.ts";
import { MEMBER_SCRIPTS_REF } from "./script.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CEO = { kind: "ceo" as const, agentId: null, name: null };

/** 待っている流れ（承認待ち）を、マイクロタスクが尽きるまで進める */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

export function seedStatic(b: MockBackend): void {
  const now = b.now();
  b.repos = [
    { path: "/Users/riku/projects/rikuhiromatsu/my-project", name: "rikuhiromatsu/my-project", defaultBranch: "main", headSha: "5fd1db4", lastCommitAt: now - 3 * HOUR, dirty: true, projectId: null, seenAt: now - 5 * MIN },
    { path: "/Users/riku/projects/rikuhiromatsu/baton-sandbox", name: "rikuhiromatsu/baton-sandbox", defaultBranch: "main", headSha: "a13c09e", lastCommitAt: now - 2 * DAY, dirty: false, projectId: null, seenAt: now - 5 * MIN },
    { path: "/Users/riku/projects/yoak/nightbrew", name: "yoak/nightbrew", defaultBranch: "main", headSha: "e8b11f0", lastCommitAt: now - 6 * DAY, dirty: false, projectId: null, seenAt: now - 5 * MIN },
  ];
  const tools = {
    coo: ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
    leader: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch", "TodoWrite"],
    member: ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "TodoWrite"],
  };
  const profiles: ProfileView[] = [
    { id: "coo", role: "coo", model: "opus", skills: [], tools: tools.coo, mcp: [], codexReview: false },
    { id: "leader", role: "leader", model: "sonnet", skills: [], tools: tools.leader, mcp: [], codexReview: false },
    { id: "engineer", role: "member", model: "sonnet", skills: [], tools: tools.member, mcp: [], codexReview: true },
    { id: "researcher", role: "member", model: "sonnet", skills: ["sns-url-research", "prior-art-search"], tools: [...tools.member, "Skill"], mcp: [], codexReview: false },
    { id: "writer", role: "member", model: "sonnet", skills: [], tools: tools.member, mcp: [], codexReview: false },
    { id: "generalist", role: "member", model: "sonnet", skills: [], tools: tools.member, mcp: [], codexReview: false },
  ];
  b.profiles = profiles;
  const tokenId = uuid();
  b.botTokens = [{ id: tokenId, name: "Grok 秘書", scopes: ["read", "message", "propose"], createdAt: now - 9 * DAY, lastUsedAt: now - 4 * MIN, revokedAt: null }];
  b.botAudit = [
    { id: uuid(), tokenId, via: "mcp", action: "baton_send_to_coo", target: COO_THREAD_ID, summary: "明日の撮影の前に、台本の 1〜3 本目だけ…", outcome: "ok", createdAt: now - 4 * MIN },
    { id: uuid(), tokenId, via: "mcp", action: "baton_overview", target: null, summary: "全体の様子", outcome: "ok", createdAt: now - 5 * MIN },
    { id: uuid(), tokenId, via: "http", action: "baton_list_waiting", target: null, summary: "承認待ち 1 件", outcome: "ok", createdAt: now - 2 * HOUR },
  ];
  b.pushSubs = [{ id: uuid(), deviceLabel: "iPhone · Safari", host: "web.push.apple.com", enabled: true, createdAt: now - 3 * DAY, lastSuccessAt: now - 26 * MIN }];
}

/** 進行中の状態を作る（既定の ?mock=1） */
export async function seedFull(b: MockBackend, flows: Flows, opts: { still: boolean }): Promise<void> {
  seedStatic(b);
  b.instant = true;

  const coffee = b.addProject({
    slug: "coffee-recipe",
    name: "コーヒーのレシピ集",
    goal: "家で再現できるハンドドリップのレシピを 20 本まとめる",
    summary: "ハンドドリップのレシピ",
    leader: { name: "ソラ", specialty: "段取りと品質" },
    members: [
      { name: "ハル", specialty: "豆と焙煎の下調べ", profile: "researcher" },
      { name: "ユイ", specialty: "レシピを書く", profile: "writer" },
    ],
  });
  const autoedit = b.addProject({
    slug: "short-video-auto-edit",
    name: "ショート動画の自動編集",
    goal: "撮った動画の無音を詰めて、字幕を付けるまでを自動にする",
    summary: "動画の自動編集",
    repo: { path: "/Users/riku/projects/rikuhiromatsu/my-project", name: "rikuhiromatsu/my-project", baseBranch: "main" },
    leader: { name: "レン", specialty: "設計とレビュー" },
    members: [
      { name: "トウマ", specialty: "動画処理の実装", profile: "engineer" },
      { name: "サキ", specialty: "テストと仕上げ", profile: "engineer" },
    ],
  });

  // 3 日前: 終わった仕事（承認済み）
  b.travel(-3 * DAY);
  b.addMessage(COO_THREAD_ID, CEO, "去年のレシピを 1 つのページにまとめておいて", { at: b.now() });
  b.threads.get(COO_THREAD_ID)!.lastReadSeq = 99;
  const m0 = await b.stream(COO_THREAD_ID, COO_AUTHOR, "了解です。コーヒーのレシピ集のリーダーに振ります。", { notify: true });
  const done = b.addInstruction({ project: coffee, title: "去年のレシピの整理", body: "去年のレシピを 1 つのページにまとめる", originMessageId: m0.id });
  flows.delegationCards(done, coffee, done.summary.body);
  await flows.runGeneric(done, coffee, done.summary.body);
  b.setInst(done, { status: "done" });
  b.addMessage(COO_THREAD_ID, { kind: "system", agentId: null, name: null }, "承認", { kind: "notice", instructionId: done.summary.id, ref: { notice: "approve" } });

  // 2 日前: アーカイブ済み
  b.travel(-2 * DAY);
  const old = b.addInstruction({ project: coffee, title: "豆の保存方法の下調べ", body: "豆の保存方法を調べる", status: "done", resultSummary: "冷凍が一番長持ち。小分けにして空気を抜く。" });
  old.archivedFrom = "done";
  b.setInst(old, { status: "archived" });

  // 2 時間前: 既存リポジトリの仕事（失敗）
  b.travel(-2 * HOUR);
  b.addInstruction({ project: autoedit, title: "書き出しを 2 倍速く", body: "書き出しの時間を半分に", status: "failed", error: "上限: 1 指示の推定額 30 USD を超えました" });

  // 70 分前: 既存リポジトリの仕事（承認待ちで止まる）
  b.travel(-70 * MIN);
  b.addMessage(COO_THREAD_ID, CEO, "動画の字幕、顔にかぶらない位置に自動で置けるようにしたい", { ref: { contextProjectId: autoedit.id } });
  const m3 = await b.stream(COO_THREAD_ID, COO_AUTHOR, "「ショート動画の自動編集」のリーダーに依頼します。", { notify: true });
  const sub = b.addInstruction({ project: autoedit, title: "字幕の位置を自動で決める", body: "顔の位置を見て、字幕を顔にかぶらない位置に置く", originMessageId: m3.id });
  flows.delegationCards(sub, autoedit, sub.summary.body);
  b.run(() => flows.runGeneric(sub, autoedit, sub.summary.body));
  await settle();
  // CEO がリーダーに降りて話した跡（未読 1）
  b.travel(-62 * MIN);
  const lt = b.leaderThreadId(autoedit);
  b.addMessage(lt, CEO, "字幕は顔にかぶらないのが一番。位置は下でいい");
  b.threads.get(lt)!.lastReadSeq = b.threads.get(lt)!.messages.length;
  await b.stream(lt, b.leaderAuthor(autoedit), "了解です。顔の下に置きます。依存を 1 つ足すので、承認をお願いするかもしれません。", { notify: true });

  // 50 分前: レシピ集の仕事（メンバーが作業中）
  b.travel(-50 * MIN);
  b.addMessage(COO_THREAD_ID, CEO, "コーヒーのレシピ集、浅煎りから進めてほしい", { ref: { contextProjectId: coffee.id } });
  const m2 = await b.stream(COO_THREAD_ID, COO_AUTHOR, "了解です。浅煎りのレシピ 5 本からリーダーに振ります。", { notify: true });
  const light = b.addInstruction({ project: coffee, title: "浅煎りのレシピ 5 本", body: "浅煎りの豆で、家で再現できるレシピを 5 本", originMessageId: m2.id });
  flows.delegationCards(light, coffee, light.summary.body);
  b.addInstruction({ project: coffee, title: "深煎りのレシピ 5 本", body: "深煎りの豆で 5 本" });

  // 45 分前〜: シナリオ A（A1〜A8）
  b.travel(-45 * MIN);
  b.addMessage(COO_THREAD_ID, CEO, "ショート動画の台本 10 本作りたい");
  await b.stream(COO_THREAD_ID, COO_AUTHOR, "なんの動画ですか？", { notify: true, awaitingReply: true });
  b.addMessage(COO_THREAD_ID, CEO, "コーヒー紹介のやつです。題材は提案して。");
  const m1 = await b.stream(COO_THREAD_ID, COO_AUTHOR, "わかりました、ではチームリーダーに依頼します。", { notify: true });
  await flows.runShortsRound1(m1);
  b.travel(-20 * MIN);
  const shorts = flows.shortsProject();
  const st = b.leaderThreadId(shorts);
  const niche = b.addMessage(st, CEO, "方向性がちょっと違うかも。もっとニッチなやつがいい");
  await flows.runShortsNiche(shorts, niche);
  const thanks = b.addMessage(st, CEO, "たすかる！");
  b.patchMessage(thanks, { reaction: "ack" });
  b.threads.get(st)!.lastReadSeq = 999;

  // 5 分前: 秘書から・COO の返事・プロジェクト案
  b.travel(-5 * MIN);
  b.addMessage(COO_THREAD_ID, { kind: "secretary", agentId: null, name: "Grok 秘書" }, "明日の撮影の前に、台本の 1〜3 本目だけ先に確定できるか、CEO に代わって確認したいです。");
  await b.stream(COO_THREAD_ID, COO_AUTHOR, "1〜3 本目はこのまま確定で大丈夫です。CEO の確認がとれたら、撮影用に字幕も付けます。", { notify: true });
  const coo = b.threads.get(COO_THREAD_ID)!;
  coo.lastReadSeq = coo.messages.reduce((m, x) => Math.max(m, x.seq), 0);
  b.travel(-1 * MIN);
  const sandbox = b.repos.find((r) => r.name === "rikuhiromatsu/baton-sandbox")!;
  const proposal = {
    id: uuid(),
    threadId: COO_THREAD_ID,
    messageId: null as string | null,
    status: "pending" as const,
    projectId: null,
    name: "撮影素材の整理",
    slug: "footage-tidy",
    goal: "撮りためた素材を、使える・使えないで仕分けて、毎週の編集を 30 分短くする",
    summary: "撮影素材の仕分けと命名のルール",
    workspace: { kind: "repo" as const, repoPath: sandbox.path, repoName: sandbox.name },
    leader: { name: "ハル", specialty: "段取りと進行" },
    members: [
      { name: "ソウ", specialty: "命名のルールを決める", profile: "writer" as const },
      { name: "イオ", specialty: "仕分けのスクリプト", profile: "engineer" as const },
    ],
    createdAt: b.now(),
    decidedAt: null,
  };
  b.proposals.set(proposal.id, proposal);
  const pm: ThreadMessage = await b.stream(COO_THREAD_ID, COO_AUTHOR, "撮りためた素材の整理は長く続きそうなので、プロジェクトとして立てるのがよさそうです。案を出します。", {
    kind: "project_proposal",
    notify: true,
    ref: { proposalId: proposal.id },
  });
  b.proposals.set(proposal.id, { ...proposal, messageId: pm.id });

  // 浅煎りの仕事: 止めた絵（still）では途中で止め、そうでなければ今から動かす
  b.travel(-40_000);
  const [haru, yui] = coffee.agents.filter((a) => a.role === "member");
  b.setInst(light, { status: "running", phase: "leader" });
  await flows.leaderTurn(light, coffee, `[COO] ${light.summary.body}`, "了解です。下調べとレシピ書きを並べて進めます", false, [
    { key: "t1", title: "浅煎りの豆を調べる", assignee: haru!.name },
    { key: "t2", title: "レシピを書く", assignee: yui!.name },
  ]);
  b.setInst(light, { phase: "members" });
  b.addWorkspace(light, { purpose: "integration" });
  b.instant = false;
  b.travel(0);
  const runLight = async () => {
    await Promise.all([
      b.runMember(light, {
        agent: haru!,
        taskKey: "t1",
        title: "浅煎りの豆を調べる",
        spec: "浅煎りに向く豆を 5 つ。産地と特徴を一言で。",
        paths: ["research/"],
        steps: MEMBER_SCRIPTS_REF.RESEARCH_STEPS,
        summary: "浅煎りに向く豆を 5 つまとめた",
        artifacts: [{ path: "research/light-beans.md", title: "浅煎りの豆", preview: "# 浅煎りの豆\n\n- エチオピア イルガチェフェ: 花の香り\n- ケニア: ベリーの酸\n" }],
        ...(opts.still ? { haltAfter: 4 } : {}),
      }),
      (async () => {
        if (!opts.still) await b.sleep(4000);
        await b.runMember(light, {
          agent: yui!,
          taskKey: "t2",
          title: "レシピを書く",
          spec: "豆ごとに 1 本。湯温・挽き目・時間を数字で。",
          paths: ["recipes/"],
          steps: MEMBER_SCRIPTS_REF.WRITER_STEPS,
          summary: "レシピを 5 本書いた",
          ...(opts.still ? { haltAfter: 3 } : {}),
        });
      })(),
    ]);
    await flows.leaderTurn(light, coffee, "[メンバーの結果] t1 done / t2 done", "まとめて COO に報告します", false);
    await flows.present(light, "浅煎りのレシピ 5 本ができました。\n\n1. エチオピア: 92℃・中細挽き・2 分 30 秒\n2. ケニア: 90℃・中挽き・2 分 45 秒\n3. グアテマラ: 91℃・中細挽き・2 分 40 秒\n4. コスタリカ: 92℃・中挽き・2 分 50 秒\n5. パナマ: 93℃・細挽き・2 分 20 秒");
  };
  if (opts.still) {
    // 止めた絵: 途中まで一気に進めて止める
    b.instant = true;
    b.run(runLight);
    await settle();
    b.instant = false;
    b.travel(0);
  } else {
    b.run(runLight);
  }
}

/** シナリオ A を最初から（COO の会話は空。ほかのプロジェクトはある） */
export async function seedScenario(b: MockBackend): Promise<void> {
  seedStatic(b);
  b.addProject({
    slug: "coffee-recipe",
    name: "コーヒーのレシピ集",
    goal: "家で再現できるハンドドリップのレシピを 20 本まとめる",
    leader: { name: "ソラ", specialty: "段取りと品質" },
    members: [
      { name: "ハル", specialty: "豆と焙煎の下調べ", profile: "researcher" },
      { name: "ユイ", specialty: "レシピを書く", profile: "writer" },
    ],
  });
}

/**
 * シナリオ A を時間差で再生する（14.1 の A1〜A8。CEO の発言をモックが代わりに送る）。
 * 画面は利用者が動かしてよい。各段の終わりを待ってから次を送る
 */
export async function playScenarioA(b: MockBackend, flows: Flows, opts: { pauseMs?: number } = {}): Promise<void> {
  const pause = opts.pauseMs ?? 2500;
  const coo = () => b.threads.get(COO_THREAD_ID)!;
  const say = (threadId: string, text: string) => {
    const msg = b.addMessage(threadId, CEO, text, { clientId: uuid() });
    const rec = b.threads.get(threadId)!;
    rec.lastReadSeq = Math.max(rec.lastReadSeq, msg.seq);
    return msg;
  };
  const untilIdle = async (threadId: string) => {
    await b.sleep(300);
    while (b.threads.get(threadId)!.summary.status !== "idle") await b.sleep(250);
  };
  await b.sleep(pause);
  // A1
  await flows.cooTurn(say(COO_THREAD_ID, "ショート動画の台本 10 本作りたい"));
  await b.sleep(pause);
  // A2〜A3
  const m = say(COO_THREAD_ID, "コーヒー紹介のやつです。題材は提案して。");
  const reply = await b.stream(COO_THREAD_ID, COO_AUTHOR, "わかりました、ではチームリーダーに依頼します。", { notify: true, thinkMs: 800 });
  void m;
  await flows.runShortsRound1(reply);
  await untilIdle(COO_THREAD_ID);
  await b.sleep(pause * 1.5);
  // A4〜A5（リーダーに降りて方向修正）
  const shorts = flows.shortsProject();
  const lt = b.leaderThreadId(shorts);
  const niche = say(lt, "方向性がちょっと違うかも。もっとニッチなやつがいい");
  const nichePromise = flows.runShortsNiche(shorts, niche);
  await b.sleep(pause * 2);
  // A6（相づち）
  const thanks = say(lt, "たすかる！");
  await b.sleep(500);
  b.patchMessage(thanks, { reaction: "ack" });
  await nichePromise;
  void coo;
}
