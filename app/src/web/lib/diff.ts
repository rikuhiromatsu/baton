// unified diff をファイルごとに分ける（13.7 の「変更」タブ。F9）
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";
export type DiffLine = { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null };
export type DiffFile = { path: string; lines: DiffLine[] };

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/** パッチをファイルごとの行に分ける。行番号は @@ から数える */
export function parsePatch(patch: string | null): DiffFile[] {
  if (!patch) return [];
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const g = raw.match(GIT_HEADER);
    if (g) {
      cur = { path: g[2]!, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) {
      // diff --git が無い（--- と +++ だけ）パッチ
      if (raw.startsWith("+++ ")) {
        cur = { path: raw.slice(4).replace(/^b\//, ""), lines: [] };
        files.push(cur);
      }
      continue;
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") || raw.startsWith("rename ")) {
      if (raw.startsWith("+++ ") && !raw.startsWith("+++ /dev/null")) cur.path = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      cur.lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (raw.startsWith("\\")) cur.lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    else if (raw.length > 0 || cur.lines.length > 0) cur.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
  }
  // 末尾の空行（パッチの最後の改行）を落とす
  for (const f of files) {
    while (f.lines.length > 0 && f.lines[f.lines.length - 1]!.kind === "ctx" && f.lines[f.lines.length - 1]!.text === "") f.lines.pop();
  }
  return files;
}

/** Edit・Write の patch（@@ 付きの行の列）を行に */
export function parseHunks(patch: string): DiffLine[] {
  return parsePatch(`diff --git a/x b/x\n${patch}`)[0]?.lines ?? [];
}
