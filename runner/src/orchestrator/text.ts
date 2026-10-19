// 報告の体裁を整える（D-37）。
// COO（gpt-oss-120b）は JSON モードで改行を書かず、段落の区切りを「空白＋全角空白」や「空白 2 つ」で表すことがある。
// 画面はプレーンテキストで改行どおりに出す（D-17）ので、保存する前にそれらを改行へ直す。改行が入っている文はそのまま。

export function restoreLineBreaks(text: string): string {
  if (text.includes("\n")) return text.trim();
  return text
    .replace(/[ \t]*　+[ \t]*/g, "\n") // 全角空白で区切った段落
    .replace(/[ \t]{2,}/g, "\n") // 空白 2 つ以上の区切り
    .replace(/[ \t]+(?=・)/g, "\n") // 文中の「・」箇条書き
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
