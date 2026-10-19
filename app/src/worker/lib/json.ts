// D1 の JSON 列の読み書き

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function parseObject(text: string | null | undefined): Record<string, unknown> {
  const v = parseJson<unknown>(text, {});
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 先頭 n 文字（サロゲートペアを割らない） */
export function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  return Array.from(text).slice(0, n).join("");
}
