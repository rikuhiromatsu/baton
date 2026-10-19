// F9 差分（13.7 の「変更」）: unified をファイルごとに分け、行番号を数える。ファイル一覧 → 押すと unified。ブランチ名と差分なし
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TESTIDS, UI_TEXT_V2, type Workspace, type WorkspaceDiff } from "@baton/shared";
import { DiffView } from "../../src/web/components/DiffView.tsx";
import { parseHunks, parsePatch } from "../../src/web/lib/diff.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
  "diff --git a/notes/new.md b/notes/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/notes/new.md",
  "@@ -0,0 +1,2 @@",
  "+# 新しい",
  "+本文",
  "",
].join("\n");

const ws: Workspace = {
  id: "w1",
  instructionId: "i1",
  projectId: "p1",
  purpose: "integration",
  taskId: null,
  parentId: null,
  kind: "repo",
  repoPath: "/r",
  worktreePath: "/w",
  branch: "baton/1a2b3c4d/integration",
  baseRef: "main",
  baseSha: "abc",
  headSha: null,
  status: "active",
  diffStat: [],
  diffTruncated: false,
  error: null,
  createdAt: 0,
  updatedAt: 0,
  finalizedAt: null,
};

describe("F9 差分", () => {
  it("ファイルごとに分け、追加・削除・前後の行番号を数える", () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "notes/new.md"]);
    const a = files[0]!.lines;
    expect(a.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "add", "ctx"]);
    expect(a.find((l) => l.kind === "del")!.oldNo).toBe(2);
    expect(a.filter((l) => l.kind === "add").map((l) => l.newNo)).toEqual([2, 3]);
    expect(a.at(-1)).toMatchObject({ oldNo: 3, newNo: 4 });
    expect(files[1]!.lines.filter((l) => l.kind === "add")).toHaveLength(2);
    expect(parsePatch(null)).toEqual([]);
  });

  it("Edit の @@ 付きの行もそのまま読める", () => {
    expect(parseHunks("@@ -1 +1 @@\n-a\n+b").map((l) => l.kind)).toEqual(["hunk", "del", "add"]);
  });

  it("ファイル一覧を出し、押すと unified が開く。既存リポジトリはブランチ名", () => {
    const diff: WorkspaceDiff = {
      workspace: ws,
      files: [
        { path: "src/a.ts", added: 2, removed: 1, change: "M" },
        { path: "notes/new.md", added: 2, removed: 0, change: "A" },
      ],
      patch: PATCH,
      truncated: false,
      reviewSummary: "c の名前が分かりにくい",
    };
    render(<DiffView diff={diff} workspace={ws} batonOnly={false} />);
    expect(screen.getByTestId(TESTIDS.branchChip).textContent).toContain("baton/1a2b3c4d/integration");
    expect(screen.getByText("c の名前が分かりにくい")).toBeTruthy();
    const files = screen.getAllByTestId(TESTIDS.diffFile);
    expect(files.map((f) => f.getAttribute("data-path"))).toEqual(["src/a.ts", "notes/new.md"]);
    // 3 ファイル以下なら先頭は開いている
    expect(within(files[0]!).getByTestId(TESTIDS.diffView).textContent).toContain("const c = 4;");
    fireEvent.click(within(files[1]!).getByRole("button"));
    expect(within(files[1]!).getByTestId(TESTIDS.diffView).textContent).toContain("本文");
  });

  it("Baton 専用は「Baton 専用」、差分が無ければ「差分なし」", () => {
    render(<DiffView diff={{ workspace: null, files: [], patch: null, truncated: false, reviewSummary: null }} workspace={null} batonOnly />);
    expect(screen.getByTestId(TESTIDS.branchChip).textContent).toContain(UI_TEXT_V2.proposal.baton);
    expect(screen.getByText(UI_TEXT_V2.diff.noDiff)).toBeTruthy();
  });
});
