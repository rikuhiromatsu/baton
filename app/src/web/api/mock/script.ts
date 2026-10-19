// モックの台本（14 章のシナリオ A と、偽 claude の汎用マーカーの一部）。
// COO・リーダーの返事はストリーミング、メンバーの作業はトランスクリプトとして時間差で流れる
import { COO_THREAD_ID, type ProjectWithTeam, type ThreadMessage } from "@baton/shared";
import { COO_AUTHOR, uuid, type MemberStep, type MockBackend } from "./backend.ts";
import type { InstRec } from "./types.ts";

const ACK = /たすかる|助かる|ありがとう|了解です?$|OK$|おけ/;

export const SHORTS_IDEAS_1 = [
  "チームリーダーから 10 本の案が上がって来ました。",
  "",
  "1. **産地別・30 秒テイスティング**（エチオピア・コロンビア・ブラジル）",
  "2. 朝の 1 杯を 3 分で淹れるハンドドリップ",
  "3. コンビニコーヒーをおいしくする小技 3 つ",
  "4. 水の温度で味がどう変わるか",
  "5. 豆の挽き目を変えて飲み比べ",
  "6. 失敗しないフレンチプレス",
  "7. 家で作るカフェラテの泡",
  "8. コーヒーと合うおやつ 3 選",
  "9. 豆の保存、冷凍はあり？",
  "10. 1 か月でわかった自分の好み",
  "",
  "変更は `baton/1a2b3c4d/integration` にまとまっています。",
].join("\n");

export const SHORTS_IDEAS_2 = [
  "ニッチ寄りに組み直した 10 本です。",
  "",
  "1. **ゲイシャ種を 30 秒で語る**（なぜ高いのか）",
  "2. 焙煎所の床に落ちた豆の行方",
  "3. 同じ豆を 4 つの水で淹れ比べ（軟水・硬水）",
  "4. 1950 年代のパーコレーターを復活させる",
  "5. カスカラ（コーヒーの果皮）のお茶",
  "6. 自家焙煎を手網でやってみる",
  "7. コーヒーの「後味」だけを比べる",
  "8. 標高 2,000m の豆はなぜ酸っぱい？",
  "9. 世界のコーヒー占い",
  "10. 1 杯の値段の内訳を分解",
  "",
  "参考にした動画と出典は `research/references.md` にあります。",
].join("\n");

const RESEARCH_STEPS: MemberStep[] = [
  { kind: "think", text: "コーヒー紹介で 30 秒に収まる題材を、産地・道具・淹れ方の 3 つの軸で洗い出す。" },
  {
    kind: "todo",
    todos: [
      { content: "伸びているコーヒー系ショートの傾向を調べる", status: "in_progress" },
      { content: "題材の候補を 15 個出す", status: "pending" },
      { content: "research/topics.md にまとめる", status: "pending" },
    ],
  },
  { kind: "tool", tool: "WebSearch", input: { query: "コーヒー ショート動画 人気 題材" }, activity: "調べている コーヒー ショート動画 人気 題材", summary: "調べた コーヒー ショート動画 人気 題材", result: "1. 30 秒で分かる産地の違い\n2. 朝のルーティン\n3. 道具の比較" },
  { kind: "tool", tool: "WebFetch", input: { url: "https://www.example.com/coffee-shorts-trends" }, activity: "取得している www.example.com", summary: "取得した www.example.com", result: "コーヒー系ショートで伸びやすいのは、手元のアップと 1 つの問い。" },
  { kind: "tool", tool: "Read", input: { file_path: "research/notes.md" }, activity: "読んでいる research/notes.md", summary: "読んだ research/notes.md", result: "# メモ\n- 30 秒以内\n- 字幕は 1 行" },
  {
    kind: "todo",
    todos: [
      { content: "伸びているコーヒー系ショートの傾向を調べる", status: "completed" },
      { content: "題材の候補を 15 個出す", status: "completed" },
      { content: "research/topics.md にまとめる", status: "in_progress" },
    ],
  },
  { kind: "write", path: "research/topics.md", content: "# 題材の候補\n\n- 産地別テイスティング\n- 3 分ハンドドリップ\n- コンビニコーヒーの小技\n- 水の温度と味\n- 挽き目の飲み比べ\n" },
  { kind: "text", text: "題材の候補を research/topics.md にまとめました。" },
];

const WRITER_STEPS: MemberStep[] = [
  { kind: "think", text: "リサーチの候補から 10 本を選び、1 本 30 秒の台本の型を決める。" },
  {
    kind: "todo",
    todos: [
      { content: "台本の型を決める（つかみ・本題・締め）", status: "in_progress" },
      { content: "10 本を書く", status: "pending" },
    ],
  },
  { kind: "tool", tool: "Glob", input: { pattern: "research/*.md" }, activity: "検索している", summary: "検索した research/*.md", result: "research/topics.md\nresearch/notes.md" },
  { kind: "tool", tool: "Read", input: { file_path: "research/topics.md" }, activity: "読んでいる research/topics.md", summary: "読んだ research/topics.md", result: "# 題材の候補\n- 産地別テイスティング" },
  { kind: "write", path: "scripts/01-origin-tasting.md", content: "# 産地別・30 秒テイスティング\n\nつかみ: 同じ「コーヒー」でも、産地で味はこんなに違う。\n本題: エチオピアは花の香り、コロンビアはナッツ、ブラジルはチョコ。\n締め: あなたはどれが好き？\n" },
  { kind: "write", path: "scripts/02-morning-drip.md", content: "# 朝の 1 杯を 3 分で\n\nつかみ: 3 分あれば、朝の 1 杯は変わる。\n本題: 蒸らし 30 秒、注ぎは 3 回。\n締め: 明日の朝、試してみて。\n" },
  {
    kind: "todo",
    todos: [
      { content: "台本の型を決める（つかみ・本題・締め）", status: "completed" },
      { content: "10 本を書く", status: "completed" },
    ],
  },
  { kind: "text", text: "10 本の台本を scripts/ に書きました。" },
];

const NICHE_STEPS: MemberStep[] = [
  { kind: "think", text: "ニッチ寄りに。専門店や愛好家が反応する題材を、参考の動画と一緒に集める。" },
  {
    kind: "todo",
    todos: [
      { content: "ニッチな題材の参考動画を集める", status: "in_progress" },
      { content: "出典つきで research/references.md にまとめる", status: "pending" },
    ],
  },
  { kind: "tool", tool: "WebSearch", input: { query: "ゲイシャ コーヒー 解説 ショート" }, activity: "調べている ゲイシャ コーヒー 解説 ショート", summary: "調べた ゲイシャ コーヒー 解説 ショート", result: "ゲイシャ種の解説動画が伸びている" },
  { kind: "tool", tool: "WebSearch", input: { query: "カスカラ 作り方" }, activity: "調べている カスカラ 作り方", summary: "調べた カスカラ 作り方", result: "カスカラはコーヒーの果皮を乾燥させたお茶" },
  { kind: "tool", tool: "WebFetch", input: { url: "https://www.example.org/geisha" }, activity: "取得している www.example.org", summary: "取得した www.example.org", result: "パナマのゲイシャ種は 2004 年の品評会で注目された" },
  { kind: "write", path: "research/references.md", content: "# 参考と出典\n\n- ゲイシャ種の解説（https://www.example.org/geisha）\n- カスカラの作り方（https://www.example.org/cascara）\n- 硬水と軟水の飲み比べ（https://www.example.org/water）\n" },
  {
    kind: "todo",
    todos: [
      { content: "ニッチな題材の参考動画を集める", status: "completed" },
      { content: "出典つきで research/references.md にまとめる", status: "completed" },
    ],
  },
  { kind: "text", text: "参考の動画と出典を research/references.md にまとめました。" },
];

const ENGINEER_STEPS: MemberStep[] = [
  { kind: "think", text: "字幕の位置は顔の位置から決める。まず既存の字幕の処理を読む。" },
  {
    kind: "todo",
    todos: [
      { content: "既存の字幕の処理を読む", status: "in_progress" },
      { content: "顔の位置から字幕の y を決める", status: "pending" },
      { content: "テストを足して通す", status: "pending" },
    ],
  },
  { kind: "tool", tool: "Grep", input: { pattern: "subtitle" }, activity: "検索している", summary: "検索した subtitle", result: "src/subtitle/place.ts\nsrc/subtitle/render.ts" },
  { kind: "tool", tool: "Read", input: { file_path: "src/subtitle/place.ts" }, activity: "読んでいる src/subtitle/place.ts", summary: "読んだ src/subtitle/place.ts", result: "export function place(frame) {\n  return { y: frame.height - 120 };\n}" },
  {
    kind: "edit",
    path: "src/subtitle/place.ts",
    patch: ["@@ -1,3 +1,6 @@", " export function place(frame) {", "-  return { y: frame.height - 120 };", "+  const face = frame.faces[0];", "+  if (!face) return { y: frame.height - 120 };", "+  const below = face.y + face.height + 24;", "+  return { y: Math.min(frame.height - 120, below) };", " }"],
    added: 4,
    removed: 1,
  },
  { kind: "approval", command: "npm install zod" },
  { kind: "tool", tool: "Bash", input: { command: "npx vitest run src/subtitle" }, activity: "実行している npx vitest run src/subtitle", summary: "実行した npx vitest run src/subtitle", result: " ✓ src/subtitle/place.test.ts (4 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)" },
  {
    kind: "todo",
    todos: [
      { content: "既存の字幕の処理を読む", status: "completed" },
      { content: "顔の位置から字幕の y を決める", status: "completed" },
      { content: "テストを足して通す", status: "completed" },
    ],
  },
  { kind: "text", text: "顔の下に字幕を置くようにしました。テストは 4 件通っています。" },
];

const IDEAS_ARTIFACTS = [
  { path: "research/topics.md", title: "題材の候補", preview: "# 題材の候補\n\n- 産地別テイスティング\n- 3 分ハンドドリップ\n- コンビニコーヒーの小技\n- 水の温度と味\n- 挽き目の飲み比べ\n" },
];
const SCRIPT_ARTIFACTS = [
  { path: "scripts/01-origin-tasting.md", title: "台本 1: 産地別テイスティング", preview: "# 産地別・30 秒テイスティング\n\nつかみ: 同じ「コーヒー」でも、産地で味はこんなに違う。\n本題: エチオピアは花の香り、コロンビアはナッツ、ブラジルはチョコ。\n締め: あなたはどれが好き？\n" },
  { path: "scripts/02-morning-drip.md", title: "台本 2: 朝の 1 杯", preview: "# 朝の 1 杯を 3 分で\n\nつかみ: 3 分あれば、朝の 1 杯は変わる。\n本題: 蒸らし 30 秒、注ぎは 3 回。\n締め: 明日の朝、試してみて。\n" },
];
const NICHE_ARTIFACTS = [
  { path: "research/references.md", title: "参考と出典", preview: "# 参考と出典\n\n- ゲイシャ種の解説（https://www.example.org/geisha）\n- カスカラの作り方（https://www.example.org/cascara）\n- 硬水と軟水の飲み比べ（https://www.example.org/water）\n" },
];

export type Flows = ReturnType<typeof installScript>;

export function installScript(b: MockBackend) {
  const shortsProject = (): ProjectWithTeam =>
    b.projects.find((p) => p.slug === "shorts") ??
    b.addProject({
      slug: "shorts",
      name: "ショート動画台本",
      goal: "コーヒー紹介のショート動画の台本を 10 本。題材は提案から。",
      summary: "コーヒー紹介のショート動画の台本",
      leader: { name: "ナギ", specialty: "構成と進行" },
      members: [
        { name: "ミナ", specialty: "参考の動画と題材を集める", profile: "researcher" },
        { name: "ケイ", specialty: "30 秒の台本を書く", profile: "writer" },
      ],
    });

  /** リーダーのターン（セッションのトランスクリプトと、スレッドの返事） */
  async function leaderTurn(rec: InstRec, p: ProjectWithTeam, input: string, reply: string | null, notify: boolean, plan?: { key: string; title: string; assignee: string }[]): Promise<void> {
    const leader = b.leaderOf(p);
    const threadId = b.leaderThreadId(p);
    let s = rec.sessions.find((x) => x.role === "leader" && x.status !== "done");
    if (!s) s = b.addSession(rec, { role: "leader", agentId: leader.id, title: leader.name, threadId });
    else s = b.setSession(rec, s, { status: "running" });
    b.addItem(s, "user", { author: "runner", summary: input.split("\n")[0]!.slice(0, 80), body: { text: input } });
    s = b.setSession(rec, s, { activity: "考えている", activityAt: b.now() });
    if (reply) {
      await b.stream(threadId, b.leaderAuthor(p), reply, { notify, instructionId: rec.summary.id, thinkMs: 700 });
      b.addItem(s, "text", { summary: reply.slice(0, 80), body: { text: reply } });
    } else {
      await b.sleep(700);
    }
    if (plan) b.addItem(s, "output", { summary: "結論", toolName: "StructuredOutput", body: { value: { reply: null, awaitingReply: false, actions: [{ type: "plan", instructionId: rec.summary.id, newTitle: null, tasks: plan.map((t) => ({ key: t.key, title: t.title, assignee: t.assignee })) }] } } });
    b.addItem(s, "result", { author: "system", summary: "終了", body: { subtype: "success", numTurns: 3, durationMs: 21_000, costUsdEst: 0.06, terminalReason: "completed", permissionDenials: [] } });
    b.setSession(rec, s, { status: "idle", activity: null, turns: s.turns + 3, costUsdEst: s.costUsdEst + 0.06 });
  }

  /** COO のターンの記録（詳細の COO のタブ）。その指示を扱ったターンだけ */
  function cooSessionItems(rec: InstRec, input: string, reply: string, action: Record<string, unknown>): void {
    let s = rec.sessions.find((x) => x.role === "coo");
    if (!s) s = b.addSession(rec, { role: "coo", agentId: "agent-coo", title: "COO", threadId: COO_THREAD_ID, status: "idle" });
    b.addItem(s, "user", { author: "runner", summary: input.split("\n")[0]!.slice(0, 80), body: { text: input } });
    const readId = `r-${uuid()}`;
    b.addItem(s, "tool_use", { toolName: "Read", toolUseId: readId, summary: "読んだ org.md", body: { input: { file_path: "org.md" } } });
    b.addItem(s, "tool_result", { toolName: "Read", toolUseId: readId, summary: "# 組織", body: { text: "# 組織\n- ショート動画台本: リーダー ナギ\n- コーヒーのレシピ集: リーダー ソラ" } });
    b.addItem(s, "text", { summary: reply.split("\n")[0]!.slice(0, 80), body: { text: reply } });
    b.addItem(s, "output", { toolName: "StructuredOutput", summary: "結論", body: { value: { reply: null, awaitingReply: false, actions: [action] } } });
    b.addItem(s, "result", { author: "system", summary: "終了", body: { subtype: "success", numTurns: 2, durationMs: 9_000, costUsdEst: 0.04, terminalReason: "completed", permissionDenials: [] } });
    b.setSession(rec, s, { status: "idle", turns: s.turns + 2, costUsdEst: s.costUsdEst + 0.04 });
  }

  /** COO が成果を CEO に出す（present。4.5） */
  async function present(rec: InstRec, text: string): Promise<void> {
    b.setInst(rec, { phase: "coo" });
    await b.stream(COO_THREAD_ID, COO_AUTHOR, text, { kind: "report", notify: true, instructionId: rec.summary.id, activities: ["読んでいる org.md"], thinkMs: 900 });
    cooSessionItems(rec, "[リーダーの成果報告]", text, { type: "present", instructionId: rec.summary.id, revision: rec.summary.revision, summary: text.slice(0, 200) });
    b.setInst(rec, { status: "review", phase: null, resultSummary: text });
  }

  function delegationCards(rec: InstRec, p: ProjectWithTeam, brief: string): void {
    cooSessionItems(rec, `[CEO] ${brief}`, "リーダーに依頼します。", { type: "delegate", title: rec.summary.title, project: { mode: "existing", projectId: p.id }, brief });
    // COO スレッドに「指示ができた」、リーダーのスレッドに COO の依頼（4.3）
    b.addMessage(COO_THREAD_ID, { kind: "system", agentId: null, name: null }, rec.summary.title ?? "", { kind: "delegation", instructionId: rec.summary.id });
    b.addMessage(b.leaderThreadId(p), COO_AUTHOR, brief, { kind: "delegation", instructionId: rec.summary.id });
  }

  /** シナリオ A の A2〜A3: 依頼 → 計画 → メンバー 2 人 → 統合 → 報告 → COO の present */
  async function runShortsRound1(cooMsg: ThreadMessage): Promise<void> {
    const p = shortsProject();
    b.broadcast({ t: "project.upserted", project: p });
    const brief = "コーヒー紹介のショート動画の台本を 10 本。題材は提案してほしいと CEO から。1 本 30 秒、字幕は 1 行で。";
    const rec = b.addInstruction({ project: p, title: "コーヒー紹介の台本 10 本", body: brief, originMessageId: cooMsg.id });
    delegationCards(rec, p, brief);
    await b.sleep(800);
    b.setInst(rec, { status: "running", phase: "leader" });
    const [m1, m2] = p.agents.filter((a) => a.role === "member");
    await leaderTurn(rec, p, `[COO] ${brief}`, "了解です。リサーチと執筆で進めます", false, [
      { key: "t1", title: "題材を集める", assignee: m1!.name },
      { key: "t2", title: "台本を書く", assignee: m2!.name },
    ]);
    b.setInst(rec, { phase: "members" });
    b.addWorkspace(rec, { purpose: "integration" });
    await Promise.all([
      b.runMember(rec, { agent: m1!, taskKey: "t1", title: "題材を集める", spec: "30 秒で見られる題材を 15 個。伸びている傾向も。", paths: ["research/"], steps: RESEARCH_STEPS, summary: "題材の候補を 15 個、research/topics.md にまとめた", artifacts: IDEAS_ARTIFACTS }),
      (async () => {
        await b.sleep(1600);
        await b.runMember(rec, { agent: m2!, taskKey: "t2", title: "台本を書く", spec: "題材の候補から 10 本。つかみ・本題・締めの型で。", paths: ["scripts/"], steps: WRITER_STEPS, summary: "10 本の台本を scripts/ に書いた", artifacts: SCRIPT_ARTIFACTS });
      })(),
    ]);
    await leaderTurn(rec, p, "[メンバーの結果] t1 done / t2 done", "まとめて COO に報告します", false);
    await present(rec, SHORTS_IDEAS_1);
  }

  /** シナリオ A の A5〜A8: CEO がリーダーに方向修正 → reopen（rev 2）→ leader_report → リサーチ → COO の present */
  async function runShortsNiche(p: ProjectWithTeam, ceoMsg: ThreadMessage): Promise<void> {
    const threadId = b.leaderThreadId(p);
    const rec = [...b.insts.values()].filter((r) => r.summary.projectId === p.id && r.summary.status !== "archived" && r.summary.status !== "canceled").sort((a, c) => c.summary.createdAt - a.summary.createdAt)[0];
    b.setThread(threadId, { talkingWithCeo: true });
    if (rec) b.setInst(rec, { talkingWithCeo: true });
    const reply = "わかりました。リサーチメンバーに参考を集めさせます";
    if (!rec) {
      await b.stream(threadId, b.leaderAuthor(p), reply, { notify: true });
      b.setThread(threadId, { talkingWithCeo: false });
      return;
    }
    if (rec.summary.status === "review" || rec.summary.status === "done") b.setInst(rec, { status: "running", phase: "leader", revision: rec.summary.revision + 1 });
    await leaderTurn(rec, p, `[CEO] ${ceoMsg.body}`, reply, true, [{ key: "t3", title: "ニッチな参考を集める", assignee: p.agents.find((a) => a.profile === "researcher")?.name ?? "" }]);
    // リーダーが COO に報告（COO のターンは起こさない。D-78）
    b.addMessage(COO_THREAD_ID, b.leaderAuthor(p), `CEO と直接話し、題材をニッチ寄りに変更。リサーチに参考集めを指示（指示 ${rec.summary.id.slice(0, 8)}、rev ${rec.summary.revision}）`, {
      kind: "leader_report",
      instructionId: rec.summary.id,
      ref: { threadId, revision: rec.summary.revision, fromSeq: ceoMsg.seq, toSeq: ceoMsg.seq + 1 },
    });
    b.setThread(threadId, { talkingWithCeo: false });
    b.setInst(rec, { talkingWithCeo: false, phase: "members" });
    const researcher = p.agents.find((a) => a.profile === "researcher") ?? p.agents.find((a) => a.role === "member")!;
    await b.runMember(rec, { agent: researcher, taskKey: "t3", title: "ニッチな参考を集める", spec: "ニッチ寄りの題材と参考の動画を出典つきで。", paths: ["research/"], round: 2, steps: NICHE_STEPS, summary: "ニッチな題材の参考を出典つきでまとめた", artifacts: NICHE_ARTIFACTS });
    await leaderTurn(rec, p, "[メンバーの結果] t3 done", null, false);
    await present(rec, SHORTS_IDEAS_2);
  }

  /** 汎用: 小さな仕事を 1 人で回して review まで */
  async function runGeneric(rec: InstRec, p: ProjectWithTeam, brief: string): Promise<void> {
    await b.sleep(600);
    b.setInst(rec, { status: "running", phase: "leader" });
    const member = p.agents.find((a) => a.role === "member")!;
    await leaderTurn(rec, p, `[COO] ${brief}`, "了解です。進めます", false, [{ key: "t1", title: rec.summary.title ?? "作業", assignee: member.name }]);
    b.setInst(rec, { phase: "members" });
    if (!rec.workspaces.some((w) => w.purpose === "integration")) b.addWorkspace(rec, { purpose: "integration" });
    const engineer = member.profile === "engineer";
    await b.runMember(rec, {
      agent: member,
      taskKey: `t${rec.tasks.length + 1}`,
      title: rec.summary.title ?? "作業",
      spec: brief,
      paths: engineer ? ["src/"] : ["notes/"],
      round: rec.tasks.length > 0 ? 2 : 1,
      steps: engineer ? ENGINEER_STEPS : RESEARCH_STEPS.slice(0, 5),
      summary: "終わりました",
      artifacts: engineer ? [] : [{ path: "notes/summary.md", title: "まとめ", preview: "# まとめ\n\n- 要点 1\n- 要点 2\n" }],
    });
    await leaderTurn(rec, p, "[メンバーの結果] done", null, false);
    await present(rec, `「${rec.summary.title}」が終わりました。\n\n- ${member.name}が作業し、統合しました\n- 残課題はありません`);
  }

  async function cooTurn(msg: ThreadMessage): Promise<void> {
    const text = msg.body;
    if (ACK.test(text.trim())) {
      await b.sleep(500);
      b.patchMessage(msg, { reaction: "ack" });
      return;
    }
    if (text.includes("[propose]")) {
      const repo = text.includes("[repo]") ? b.repos.find((r) => !r.projectId) : null;
      const proposal = {
        id: uuid(),
        threadId: COO_THREAD_ID,
        messageId: null as string | null,
        status: "pending" as const,
        projectId: null,
        name: "撮影素材の整理",
        slug: `footage-${Math.floor(Math.random() * 900 + 100)}`,
        goal: "撮りためた素材を、使える・使えないで仕分けて、毎週の編集を 30 分短くする",
        summary: "撮影素材の仕分けと命名のルール",
        workspace: repo ? { kind: "repo" as const, repoPath: repo.path, repoName: repo.name } : { kind: "baton" as const },
        leader: { name: "ハル", specialty: "段取りと進行" },
        members: [
          { name: "ソラ", specialty: "命名のルールを決める", profile: "writer" as const },
          { name: "イオ", specialty: "仕分けのスクリプト", profile: "engineer" as const },
        ],
        createdAt: b.now(),
        decidedAt: null,
      };
      b.proposals.set(proposal.id, proposal);
      b.broadcast({ t: "project_proposal.upserted", proposal });
      const m = await b.stream(COO_THREAD_ID, COO_AUTHOR, "長く続きそうなので、プロジェクトとして立てるのがよさそうです。案を出します。", { kind: "project_proposal", notify: true, ref: { proposalId: proposal.id } });
      const withMsg = { ...proposal, messageId: m.id };
      b.proposals.set(proposal.id, withMsg);
      b.broadcast({ t: "project_proposal.upserted", proposal: withMsg });
      return;
    }
    if (text.includes("[approve]")) {
      const p = b.projects.find((x) => x.workspaceKind === "repo") ?? shortsProject();
      const m = await b.stream(COO_THREAD_ID, COO_AUTHOR, `「${p.name}」のリーダーに依頼します。`, { notify: true });
      const rec = b.addInstruction({ project: p, title: "字幕の位置を自動で決める", body: text.replace("[approve]", "").trim() || "字幕の位置を自動で決める", originMessageId: m.id });
      delegationCards(rec, p, rec.summary.body);
      b.run(() => runGeneric(rec, p, rec.summary.body));
      return;
    }
    if (text.includes("台本") && !text.includes("コーヒー")) {
      await b.stream(COO_THREAD_ID, COO_AUTHOR, "なんの動画ですか？", { notify: true, awaitingReply: true, thinkMs: 900 });
      return;
    }
    if (text.includes("コーヒー")) {
      const m = await b.stream(COO_THREAD_ID, COO_AUTHOR, "わかりました、ではチームリーダーに依頼します。", { notify: true, thinkMs: 800 });
      b.run(() => runShortsRound1(m));
      return;
    }
    const ctx = typeof msg.ref.contextProjectId === "string" ? b.project(msg.ref.contextProjectId) : null;
    if (ctx) {
      await b.stream(COO_THREAD_ID, COO_AUTHOR, `「${ctx.name}」のリーダーに伝えておきます。`, { notify: true });
      b.addMessage(b.leaderThreadId(ctx), COO_AUTHOR, text, {});
      return;
    }
    await b.stream(COO_THREAD_ID, COO_AUTHOR, "わかりました。もう少し教えてください。何ができたら成功ですか？", { notify: true, awaitingReply: true });
  }

  async function leaderTurnFromCeo(p: ProjectWithTeam, msg: ThreadMessage): Promise<void> {
    const threadId = b.leaderThreadId(p);
    if (ACK.test(msg.body.trim())) {
      await b.sleep(500);
      b.patchMessage(msg, { reaction: "ack" });
      return;
    }
    if (msg.body.includes("ニッチ")) {
      await runShortsNiche(p, msg);
      return;
    }
    b.setThread(threadId, { talkingWithCeo: true });
    await b.stream(threadId, b.leaderAuthor(p), "了解です。いまの作業に反映します。", { notify: true });
    b.setThread(threadId, { talkingWithCeo: false });
  }

  b.onCeoMessage = (threadId, msg) => {
    if (threadId === COO_THREAD_ID) {
      b.run(() => cooTurn(msg));
      return;
    }
    const p = b.projects.find((x) => b.leaderThreadId(x) === threadId);
    if (p) b.run(() => leaderTurnFromCeo(p, msg));
  };

  b.onTransition = (rec, action, comment) => {
    const p = b.project(rec.summary.projectId);
    const title = rec.summary.title ?? "";
    const notice = (kind: string, body: string) => {
      b.addMessage(COO_THREAD_ID, { kind: "system", agentId: null, name: null }, body, { kind: "notice", instructionId: rec.summary.id, ref: { notice: kind } });
    };
    switch (action) {
      case "approve":
        notice("approve", "承認");
        if (p) b.addMessage(b.leaderThreadId(p), { kind: "system", agentId: null, name: null }, "承認", { kind: "notice", instructionId: rec.summary.id, ref: { notice: "approve" } });
        break;
      case "cancel":
        notice("cancel", "取消");
        break;
      case "retry":
        notice("retry", "再実行");
        if (p) {
          b.resumeInstruction(rec.summary.id);
          b.run(() => runGeneric(rec, p, rec.summary.body));
        }
        break;
      case "send_back": {
        const body = comment?.trim() || "差し戻し";
        b.addMessage(COO_THREAD_ID, { kind: "ceo", agentId: null, name: null }, body, { instructionId: rec.summary.id, ref: { notice: "send_back" } });
        b.run(async () => {
          await b.stream(COO_THREAD_ID, COO_AUTHOR, `「${title}」をその内容でリーダーに戻します。`, { notify: true, instructionId: rec.summary.id });
          if (p) await runGeneric(rec, p, body);
        });
        break;
      }
      default:
        break;
    }
  };

  b.onAcceptProposal = (proposal, project) => {
    b.run(async () => {
      const m = await b.stream(COO_THREAD_ID, COO_AUTHOR, `「${project.name}」を立てました。最初の仕事をリーダーに振ります。`, { notify: true, thinkMs: 700 });
      const brief = `目的: ${proposal.goal}\nまずは現状を把握して、進め方の案を出してください。`;
      const rec = b.addInstruction({ project, title: "現状の把握と進め方の案", body: brief, originMessageId: m.id });
      delegationCards(rec, project, brief);
      await runGeneric(rec, project, brief);
    });
  };

  b.onDeclineProposal = () => {
    b.run(async () => {
      await b.stream(COO_THREAD_ID, COO_AUTHOR, "見送りますね。必要になったらまた声をかけてください。", { notify: false });
    });
  };

  b.onFollowup = (rec, s, input) => {
    b.run(async () => {
      await b.sleep(700);
      const delivered = { ...input, status: "delivered" as const, deliveredAt: b.now() };
      const idx = b.inputs.findIndex((x) => x.id === input.id);
      if (idx >= 0) b.inputs[idx] = delivered;
      b.addItem(s, "user", { author: "ceo", summary: input.body.slice(0, 80), body: { text: input.body } });
      b.broadcast({ t: "session_input.upserted", input: delivered });
      await b.sleep(900);
      b.addItem(s, "text", { summary: "追加の依頼を受けました", body: { text: `追加の依頼を受けました: ${input.body}` } });
      b.touchInst(rec);
    });
  };

  return { shortsProject, leaderTurn, delegationCards, present, runShortsRound1, runShortsNiche, runGeneric, cooTurn, leaderTurnFromCeo, cooSessionItems };
}

export const MEMBER_SCRIPTS_REF = { RESEARCH_STEPS, WRITER_STEPS, NICHE_STEPS, ENGINEER_STEPS, IDEAS_ARTIFACTS, SCRIPT_ARTIFACTS, NICHE_ARTIFACTS };
