// F8 トランスクリプト（13.7）: 道具の呼び出しと結果を 1 行に、読み取り系の連続を「n 件の操作」に、標準は考えを出さない、
// 詳細はすべて開く。Edit・Write は差分の先頭 12 行、TODO はチェック一覧、終了は「終了 · 分 秒 · ターン」
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TESTIDS, UI_TEXT_V2, type TranscriptItem } from "@baton/shared";
import { Transcript } from "../../src/web/components/Transcript.tsx";
import { buildRows, latestTodos, patchPreview, resultStats } from "../../src/web/lib/transcript-view.ts";
import { makeQc, Wrap } from "./helpers.tsx";

let n = 0;
function it_(kind: TranscriptItem["kind"], over: Partial<TranscriptItem> = {}): TranscriptItem {
  n += 1;
  return {
    id: `t${n}`,
    sessionId: "s1",
    threadId: null,
    instructionId: "i1",
    seq: n,
    kind,
    author: "claude",
    toolName: null,
    toolUseId: null,
    parentToolUseId: null,
    summary: "",
    body: {},
    truncated: false,
    isError: false,
    createdAt: 0,
    ...over,
  };
}
const use = (tool: string, id: string, summary: string, input: Record<string, unknown> = {}) => it_("tool_use", { toolName: tool, toolUseId: id, summary, body: { input } });
const res = (tool: string, id: string, summary: string, body: Record<string, unknown> = { text: summary }, isError = false) => it_("tool_result", { toolName: tool, toolUseId: id, summary, body, isError });

function sample(): TranscriptItem[] {
  const patch = ["@@ -0,0 +1,14 @@", ...Array.from({ length: 14 }, (_, i) => `+行 ${i + 1}`)].join("\n");
  return [
    it_("system", { author: "system", summary: "開始" }),
    it_("user", { author: "runner", summary: "[タスク]", body: { text: "[タスク] 題材を集める" } }),
    it_("thinking", { summary: "考え", body: { text: "まず調べる" } }),
    use("Read", "r1", "読んだ a.md"),
    res("Read", "r1", "# a"),
    use("Grep", "g1", "検索した foo"),
    res("Grep", "g1", "a.md"),
    use("WebSearch", "w1", "調べた コーヒー"),
    res("WebSearch", "w1", "結果"),
    use("TodoWrite", "td1", "TODO を更新", { todos: [{ content: "調べる", status: "completed" }, { content: "書く", status: "in_progress", activeForm: "書いている" }] }),
    use("Write", "wr1", "作成した topics.md", { file_path: "/x/topics.md", content: "..." }),
    res("Write", "wr1", "作成した topics.md（+14 −0）", { filePath: "topics.md", type: "create", patch, added: 14, removed: 0 }),
    use("Bash", "b1", "実行した npm test", { command: "npm test" }),
    res("Bash", "b1", "失敗", { stdout: "", stderr: "fail" }, true),
    it_("text", { body: { text: "まとめました。" } }),
    it_("output", { toolName: "StructuredOutput", summary: "結論", body: { value: { kind: "done", summary: "題材を 15 個" } } }),
    it_("result", { author: "system", summary: "終了", body: { durationMs: 192_000, numTurns: 18, costUsdEst: 0.42 } }),
  ];
}

describe("F8 行の組み立て（純粋関数）", () => {
  it("標準: 考えを出さず、読み取り系 3 つを 1 つのまとまりに、道具と結果を組にする", () => {
    const rows = buildRows(sample(), "standard");
    const kinds = rows.map((r) => (r.kind === "item" ? r.item.kind : r.kind));
    expect(kinds).toEqual(["system", "user", "group", "todo", "tool", "tool", "text", "output", "result"]);
    const group = rows.find((r) => r.kind === "group")!;
    expect(group.kind === "group" && group.pairs.map((p) => p.use?.toolName)).toEqual(["Read", "Grep", "WebSearch"]);
    const write = rows.find((r) => r.kind === "tool" && r.pair.use?.toolName === "Write")!;
    expect(write.kind === "tool" && write.pair.result?.toolName).toBe("Write");
  });

  it("詳細: 考えも出し、まとめない", () => {
    const kinds = buildRows(sample(), "detailed").map((r) => (r.kind === "item" ? r.item.kind : r.kind));
    expect(kinds).toContain("thinking");
    expect(kinds).not.toContain("group");
    expect(kinds.filter((k) => k === "tool")).toHaveLength(5);
  });

  it("失敗した読み取りはまとめない。対の無い結果も 1 行になる", () => {
    const items = [use("Read", "a", "読んだ a"), res("Read", "a", "x", { text: "x" }, true), use("Read", "b", "読んだ b"), res("Read", "c", "孤立")];
    const rows = buildRows(items, "standard");
    // 失敗した a は 1 行のまま、b と孤立した c の結果はまとまる
    expect(rows[0]!.kind === "tool" && rows[0]!.pair.result?.isError).toBe(true);
    const group = rows[1]!;
    expect(group.kind).toBe("group");
    expect(group.kind === "group" && group.pairs.some((p) => p.use === null && p.result?.toolUseId === "c")).toBe(true);
  });

  it("差分は標準で先頭 12 行と残りの数、詳細で全部", () => {
    const write = sample().find((x) => x.kind === "tool_result" && x.toolName === "Write")!;
    expect(patchPreview(write, "standard")).toEqual({ lines: expect.any(Array), more: 3 });
    expect(patchPreview(write, "standard")!.lines).toHaveLength(12);
    expect(patchPreview(write, "detailed")!.lines).toHaveLength(15);
  });

  it("最新の TODO と終了の数", () => {
    expect(latestTodos(sample())!.map((t) => t.status)).toEqual(["completed", "in_progress"]);
    expect(resultStats(sample().at(-1)!)).toEqual({ minutes: 3, seconds: 12, turns: 18, costUsdEst: 0.42 });
  });
});

describe("F8 描画", () => {
  it("まとまりは「n 件の操作」で、押すと中が開く。TODO・終了の 1 行・失敗の印", () => {
    render(
      <Wrap qc={makeQc()}>
        <Transcript items={sample()} mode="standard" session={null} decisions={[]} hasMoreBefore={false} onLoadOlder={() => {}} />
      </Wrap>,
    );
    const t = screen.getByTestId(TESTIDS.transcript);
    const group = within(t).getByTestId(TESTIDS.transcriptGroup);
    expect(group.textContent).toContain("3");
    expect(group.textContent).toContain(UI_TEXT_V2.transcript.operations);
    expect(within(group).queryAllByTestId(TESTIDS.transcriptItem)).toHaveLength(0);
    fireEvent.click(within(group).getByTestId(TESTIDS.transcriptExpand));
    expect(within(group).getAllByTestId(TESTIDS.transcriptItem)).toHaveLength(3);
    expect(within(t).getAllByTestId(TESTIDS.todoItem).map((x) => x.getAttribute("data-status"))).toEqual(["completed", "in_progress"]);
    expect(within(t).getByText("書いている")).toBeTruthy();
    const result = t.querySelector('[data-kind="result"]')!;
    for (const w of [UI_TEXT_V2.transcript.end, UI_TEXT_V2.transcript.minutes, UI_TEXT_V2.transcript.seconds, UI_TEXT_V2.transcript.turns]) expect(result.textContent).toContain(w);
    expect(t.querySelector('[data-tool="Bash"]')!.classList.contains("tool-row--error")).toBe(true);
    // 標準では考えを出さない
    expect(t.querySelector('[data-kind="thinking"]')).toBeNull();
    // Write は差分の先頭が見える
    expect(t.querySelector(".mini-diff")!.textContent).toContain("行 1");
  });

  it("ランナーからの入力は「リーダーから」などの札付きの細いカード、CEO の追加の依頼は右の吹き出し", () => {
    const items = [it_("user", { author: "runner", body: { text: "[タスク] やること" } }), it_("user", { author: "ceo", body: { text: "見出しも" } })];
    render(
      <Wrap qc={makeQc()}>
        <Transcript items={items} mode="standard" session={null} decisions={[]} hasMoreBefore={false} onLoadOlder={() => {}} />
      </Wrap>,
    );
    expect(screen.getByText(UI_TEXT_V2.transcript.fromLeader)).toBeTruthy();
    expect(document.querySelector(".t-user--ceo .bubble--ceo")!.textContent).toContain("見出しも");
  });
});
