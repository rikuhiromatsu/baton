import { describe, expect, it } from "vitest";
import { restoreLineBreaks } from "../src/orchestrator/text.ts";

describe("restoreLineBreaks（D-37）", () => {
  it("全角空白の区切りを改行に直す（本番の gpt-oss-120b の出力）", () => {
    expect(restoreLineBreaks("結論: 作りました。 　根拠: 浅煎りのため。 　成果物: ・a.md ・b.txt")).toBe(
      "結論: 作りました。\n根拠: 浅煎りのため。\n成果物:\n・a.md\n・b.txt",
    );
  });
  it("空白 2 つの区切りを改行に直す", () => {
    expect(restoreLineBreaks("一段落目。  二段落目。")).toBe("一段落目。\n二段落目。");
  });
  it("改行が入っている文は変えない", () => {
    expect(restoreLineBreaks("結論\n・a  b")).toBe("結論\n・a  b");
  });
});
