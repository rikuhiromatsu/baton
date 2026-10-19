#!/usr/bin/env node
// 秘書 bot のトークンを Mac mini から発行・一覧・失効する（DESIGN-v2 11.3）。D1 には SHA-256 だけを入れる。
// トークンの本体は create のときに標準出力へ 1 回だけ出す（ほかには出さない・保存しない）。
//
// 使い方:
//   npm run bot:token -w app -- create --name "Grok 秘書" --scopes read,message,propose [--local]
//   npm run bot:token -w app -- list [--local]
//   npm run bot:token -w app -- revoke <id> [--local]
// 既定は本番の D1（wrangler d1 execute baton --remote）。--local でローカルの D1。
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const where = rest.includes("--local") ? "--local" : "--remote";
const SCOPES = new Set(["read", "message", "propose"]);
const sql = (v) => `'${String(v).replaceAll("'", "''")}'`;

function d1(command) {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", "baton", where, "--json", "--command", command], { cwd: appDir, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`[bot:token] D1 の実行に失敗しました: ${(r.stderr || r.stdout).trim()}`);
    process.exit(1);
  }
  try {
    return JSON.parse(r.stdout)?.[0]?.results ?? [];
  } catch {
    return [];
  }
}

function usage() {
  console.error('使い方: bot-token.mjs create --name "Grok 秘書" --scopes read,message,propose | list | revoke <id>  [--local]');
  process.exit(2);
}

if (cmd === "create") {
  const name = (flag("name") ?? "").trim();
  const scopes = [...new Set((flag("scopes") ?? "read").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!name || name.length > 40) usage();
  if (scopes.length === 0 || scopes.some((s) => !SCOPES.has(s))) {
    console.error(`[bot:token] スコープは ${[...SCOPES].join("・")} から選んでください`);
    process.exit(2);
  }
  const token = `btn_bot_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const id = randomUUID();
  // created_by は CEO（個人用なので最初の利用者）。利用者がいなければ入らない
  d1(
    `INSERT INTO bot_tokens (id, name, token_hash, scopes, created_by, created_at)
     SELECT ${sql(id)}, ${sql(name)}, ${sql(hash)}, ${sql(JSON.stringify(scopes))}, u.id, ${Date.now()} FROM users u ORDER BY u.created_at LIMIT 1`,
  );
  const ok = d1(`SELECT id FROM bot_tokens WHERE id = ${sql(id)}`);
  if (ok.length !== 1) {
    console.error("[bot:token] 発行できませんでした（先に Baton にログインして利用者を作ってください）");
    process.exit(1);
  }
  console.error(`[bot:token] 発行しました（id ${id}、スコープ ${scopes.join(",")}）。次の行がトークンです。二度と表示されません。`);
  process.stdout.write(`${token}\n`);
} else if (cmd === "list") {
  for (const r of d1("SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM bot_tokens ORDER BY created_at DESC")) {
    const state = r.revoked_at ? "失効" : "有効";
    console.log(`${r.id}  ${state}  ${r.name}  ${r.scopes}  最後に使った: ${r.last_used_at ? new Date(r.last_used_at).toISOString() : "-"}`);
  }
} else if (cmd === "revoke") {
  const id = rest.find((x) => !x.startsWith("--"));
  if (!id) usage();
  d1(`UPDATE bot_tokens SET revoked_at = COALESCE(revoked_at, ${Date.now()}) WHERE id = ${sql(id)}`);
  console.log(`[bot:token] ${id} を失効しました（次の呼び出しから 401）`);
} else {
  usage();
}
