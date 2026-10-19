// ランナーの登録（設計書 6.4）。`npm run register -w runner`（Mac mini で 1 回だけ）。
//   1. 32 バイトの乱数トークンを作る
//   2. SHA-256（hex）を `npx wrangler d1 execute baton --remote --command "…"` で runners に登録（同じ名前の古い行は revoked = 1）
//   3. トークン本体を ~/.config/baton/runner.env（600）に書く
// トークンはどこにも表示しない。`--dry-run` は書き込みも wrangler も実行せず、何をするかだけ出す。
// オプション: --dry-run / --name <名前> / --env-file <パス> / --app-dir <wrangler.jsonc のあるフォルダ>
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { parseEnvFile } from "../src/config.ts";

export const DEFAULTS = {
  BATON_URL: "https://baton.rikuhiromatsu.workers.dev",
  BATON_DATA_DIR: "~/baton-data",
  BATON_TAILNET_URL: "https://rikumac-mini.tail6eb659.ts.net",
  BATON_LOCAL_PORT: "7777",
};

/** env ファイルに書く順番 */
const KEY_ORDER = [
  "BATON_URL",
  "BATON_RUNNER_TOKEN",
  "BATON_RUNNER_NAME",
  "BATON_DATA_DIR",
  "BATON_TAILNET_URL",
  "BATON_LOCAL_PORT",
  "ALLOWED_TAILNET_LOGINS",
];

export function sanitizeName(name: string): string {
  const s = name.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw new Error(`ランナー名に使えない文字があります: ${name}`);
  return s;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 古い行の失効と新しい行の追加。値は検査済みの英数字だけなので引用符の中に直接書ける */
export function buildRegisterSql(opts: { id: string; name: string; tokenHash: string; now: number }): string {
  if (!/^[0-9a-f-]{36}$/.test(opts.id)) throw new Error("id が不正です");
  if (!/^[0-9a-f]{64}$/.test(opts.tokenHash)) throw new Error("hash が不正です");
  const name = sanitizeName(opts.name);
  return (
    `UPDATE runners SET revoked = 1 WHERE name = '${name}' AND revoked = 0; ` +
    `INSERT INTO runners (id, name, token_hash, created_at) VALUES ('${opts.id}', '${name}', '${opts.tokenHash}', ${Math.floor(opts.now)});`
  );
}

export function renderEnvFile(values: Record<string, string>): string {
  const keys = [...KEY_ORDER.filter((k) => k in values), ...Object.keys(values).filter((k) => !KEY_ORDER.includes(k)).sort()];
  return (
    "# Baton ランナーの設定（npm run register -w runner が作成。トークンを含むので 600 のまま）\n" +
    keys.map((k) => `${k}=${(values[k] ?? "").replace(/[\r\n]/g, "")}`).join("\n") +
    "\n"
  );
}

/** tailscale status --json から本人のログイン名と、このマシンの tailnet の URL を取る */
export function parseTailscaleStatus(json: string): { login: string | null; url: string | null } {
  try {
    const st = JSON.parse(json) as { Self?: { UserID?: number; DNSName?: string }; User?: Record<string, { LoginName?: string }> };
    const uid = st.Self?.UserID;
    const login = uid !== undefined ? (st.User?.[String(uid)]?.LoginName ?? null) : null;
    const dns = st.Self?.DNSName?.replace(/\.$/, "");
    return { login, url: dns ? `https://${dns}` : null };
  } catch {
    return { login: null, url: null };
  }
}

function readTailscale(): { login: string | null; url: string | null } {
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]) {
    try {
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
      return parseTailscaleStatus(out);
    } catch {
      // 次を試す
    }
  }
  return { login: null, url: null };
}

export type RegisterDeps = {
  now: () => number;
  token: () => string;
  id: () => string;
  runWrangler: (args: string[], cwd: string) => void;
  tailscale: () => { login: string | null; url: string | null };
  out: (line: string) => void;
};

const realDeps: RegisterDeps = {
  now: Date.now,
  token: () => randomBytes(32).toString("base64url"),
  id: () => randomUUID(),
  runWrangler: (args, cwd) => {
    execFileSync("npx", ["wrangler", ...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
  },
  tailscale: readTailscale,
  out: (l) => console.log(l),
};

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function register(argv: string[], deps: RegisterDeps = realDeps): Promise<{ envFile: string; sql: string; dryRun: boolean }> {
  const dryRun = argv.includes("--dry-run");
  const envFile = path.resolve(argValue(argv, "--env-file") ?? path.join(homedir(), ".config/baton/runner.env"));
  const appDir = path.resolve(argValue(argv, "--app-dir") ?? path.join(import.meta.dirname, "../../app"));

  let existing: Record<string, string> = {};
  try {
    existing = parseEnvFile(await readFile(envFile, "utf8"));
  } catch {
    existing = {};
  }
  const name = sanitizeName(argValue(argv, "--name") ?? existing.BATON_RUNNER_NAME ?? hostname().split(".")[0] ?? "baton-runner");
  const ts = deps.tailscale();

  const token = deps.token();
  const tokenHash = sha256Hex(token);
  const id = deps.id();
  const sql = buildRegisterSql({ id, name, tokenHash, now: deps.now() });
  const wranglerArgs = ["d1", "execute", "baton", "--remote", "--command", sql];

  const values: Record<string, string> = {
    ...DEFAULTS,
    ...(ts.url ? { BATON_TAILNET_URL: ts.url } : {}),
    ...existing,
    BATON_RUNNER_TOKEN: token,
    BATON_RUNNER_NAME: name,
  };
  if (!values.ALLOWED_TAILNET_LOGINS && ts.login) values.ALLOWED_TAILNET_LOGINS = ts.login;
  if (!values.ALLOWED_TAILNET_LOGINS) values.ALLOWED_TAILNET_LOGINS = "";

  const shownSql = sql.replace(tokenHash, "<トークンの SHA-256>");
  if (dryRun) {
    deps.out("[dry-run] 何も書き込みません。実行すると次を行います:");
    deps.out(`  1. 32 バイトの乱数トークンを作る（表示しません）`);
    deps.out(`  2. ${appDir} で npx wrangler d1 execute baton --remote --command "${shownSql}"`);
    deps.out(`  3. ${envFile} に書く（権限 600）。キー: ${Object.keys(values).join(", ")}`);
    if (!values.ALLOWED_TAILNET_LOGINS) deps.out("  注意: Tailscale のログイン名が取れませんでした。ALLOWED_TAILNET_LOGINS を手で入れてください");
    return { envFile, sql: shownSql, dryRun };
  }

  deps.out(`ランナー「${name}」を登録します（同じ名前の古いトークンは失効させます）`);
  deps.runWrangler(wranglerArgs, appDir);

  await mkdir(path.dirname(envFile), { recursive: true, mode: 0o700 });
  const tmp = `${envFile}.tmp-${process.pid}`;
  await writeFile(tmp, renderEnvFile(values), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, envFile);
  await chmod(envFile, 0o600);
  deps.out(`登録しました。設定を ${envFile} に書きました（トークンは表示しません）`);
  if (!values.ALLOWED_TAILNET_LOGINS) deps.out("注意: Tailscale のログイン名が取れませんでした。ALLOWED_TAILNET_LOGINS を手で入れてください");
  return { envFile, sql: shownSql, dryRun };
}

if (import.meta.main) {
  register(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`登録に失敗しました: ${(err as Error).message}`);
    process.exit(1);
  });
}
