// モデルごとに違う戻り値を { text, usage } に揃える（設計書 2.2）
export type NormalizedAiResult = { text: string; usage: { tokensIn: number; tokensOut: number } | null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" ? p.text : null))
      .filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join("") : null;
  }
  if (isObj(content)) return JSON.stringify(content);
  return null;
}

function readUsage(u: unknown): NormalizedAiResult["usage"] {
  if (!isObj(u)) return null;
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return null;
  };
  const tokensIn = num("prompt_tokens", "input_tokens", "promptTokens");
  const tokensOut = num("completion_tokens", "output_tokens", "completionTokens");
  if (tokensIn === null && tokensOut === null) return null;
  return { tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 };
}

/** 推論モデルが本文に混ぜる <think>…</think> を落とす */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function normalizeAiResult(raw: unknown): NormalizedAiResult {
  if (typeof raw === "string") return { text: stripThinking(raw), usage: null };
  if (!isObj(raw)) return { text: "", usage: null };
  // REST の { success, result: {...} } で包まれた形
  if (isObj(raw.result) && !("response" in raw) && !("choices" in raw)) {
    return normalizeAiResult(raw.result);
  }
  const usage = readUsage(raw.usage);

  // OpenAI 互換: { choices: [{ message: { content, reasoning_content } }], usage }
  if (Array.isArray(raw.choices) && raw.choices.length > 0) {
    const first = raw.choices[0];
    if (isObj(first)) {
      const message = isObj(first.message) ? first.message : null;
      const text = contentToText(message?.content) ?? (typeof first.text === "string" ? first.text : null);
      if (text !== null) return { text: stripThinking(text), usage };
      // 本文が空で tool_calls だけ返ってきた場合は引数の JSON を本文として扱う
      const call = Array.isArray(message?.tool_calls) ? message.tool_calls[0] : null;
      if (isObj(call) && isObj(call.function) && typeof call.function.arguments === "string") {
        return { text: call.function.arguments, usage };
      }
    }
    return { text: "", usage };
  }

  // Workers AI 従来形: { response, tool_calls, usage }。JSON モードでは response がオブジェクトのこともある
  if ("response" in raw) {
    const text = contentToText(raw.response);
    if (text !== null && text !== "") return { text: stripThinking(text), usage };
    const call = Array.isArray(raw.tool_calls) ? raw.tool_calls[0] : null;
    if (isObj(call) && isObj(call.arguments)) return { text: JSON.stringify(call.arguments), usage };
    return { text: text ?? "", usage };
  }

  // Responses API 形（gpt-oss）: { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }] }
  if (Array.isArray(raw.output)) {
    const texts: string[] = [];
    for (const item of raw.output) {
      if (isObj(item) && item.type === "message") {
        const t = contentToText(item.content);
        if (t) texts.push(t);
      }
    }
    return { text: stripThinking(texts.join("")), usage };
  }
  if (typeof raw.output_text === "string") return { text: stripThinking(raw.output_text), usage };

  return { text: "", usage };
}

/**
 * 本文から最初の JSON オブジェクト（{ … }）を取り出す（設計書 2.2 の構造化出力の方式）。
 * 見つからなければ null。文字列中の括弧は数えない。
 */
export function extractFirstJsonObject(text: string): string | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/** 使用量が返ってこなかったときの見積もり（文字数 / 3。上限の判定を甘くしないため多めに見る） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
