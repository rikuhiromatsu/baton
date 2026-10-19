// テスト用ルートを通すかの判定（設計書 6.5・D-15）。4 条件すべてが真のときだけ true
import type { Env } from "../env.ts";

export function testRoutesAllowed(
  buildMode: string,
  env: Pick<Env, "BATON_ENV" | "E2E_TEST_SECRET">,
  url: string,
  secretHeader: string | undefined | null,
): boolean {
  if (buildMode !== "e2e") return false; // 1. ビルド時
  if (env.BATON_ENV !== "e2e") return false; // 2. 実行時
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return false; // 3. 接続元
  const secret = env.E2E_TEST_SECRET;
  return typeof secret === "string" && secret.length > 0 && secretHeader === secret; // 4. 共有秘密
}
