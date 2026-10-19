// 子プロセス（claude）の環境変数は許可リスト（DESIGN-v2 7.7・D-48）。ランナーの process.env は引き継がない。
// ANTHROPIC_API_KEY・ANTHROPIC_AUTH_TOKEN・CLAUDE_CODE_USE_*・BATON_RUNNER_TOKEN・GH_TOKEN などは渡りようがない。
// 例外: 偽 claude（テスト・E2E）の設定 FAKE_* だけは通す（中身は台本の調整だけで、認証に関わらない）。
import { tmpdir, userInfo } from "node:os";

/** 子に渡してはいけない名前（許可リストの外なので本来渡らないが、FAKE_ の通し道でも念のため弾く） */
const FORBIDDEN = /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|BATON_RUNNER_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$|OPENAI_)/;

export function childEnv(opts: { home: string; passthrough?: Record<string, string | undefined> }): Record<string, string> {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return "baton";
    }
  })();
  const env: Record<string, string> = {
    HOME: opts.home,
    USER: user,
    LOGNAME: user,
    TMPDIR: tmpdir(),
    PATH: `${opts.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    SHELL: "/bin/zsh",
    LANG: "ja_JP.UTF-8",
    TERM: "dumb",
    CLAUDE_CODE_ENABLE_TASKS: "0",
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
  };
  for (const [k, v] of Object.entries(opts.passthrough ?? {})) {
    if (v === undefined || !k.startsWith("FAKE_") || FORBIDDEN.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** init の検査（7.7）。問題があれば理由、無ければ null */
export function checkInit(init: { apiKeySource: string | null; mcpServers: readonly string[] }): string | null {
  if (init.apiKeySource !== "none") return `サブスク以外の認証（apiKeySource: ${init.apiKeySource ?? "不明"}）`;
  if (init.mcpServers.length > 0) return `MCP サーバーが読み込まれた（${init.mcpServers.join(", ")}）`;
  return null;
}
