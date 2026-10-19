#!/usr/bin/env node
// Web Push の VAPID の鍵（P-256）を作り、Worker のシークレットに登録する（DESIGN-v2 10.3・16.2 の 3）。
// 鍵は画面にもファイルにも出さない（wrangler secret put に標準入力で渡す）。wrangler の既存の OAuth（workers の書き込み）で足りる。
//
// 使い方: npm run push:keys -w app [-- --env <wrangler の環境名>] [-- --force]
//   既に VAPID_PUBLIC_KEY が登録済みなら止まる（鍵を変えると既存の購読がすべて使えなくなるため）。--force で作り直す。
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const envArgs = envIndex >= 0 && args[envIndex + 1] ? ["--env", args[envIndex + 1]] : [];
const force = args.includes("--force");

function wrangler(argv, input) {
  return spawnSync("npx", ["wrangler", ...argv, ...envArgs], { cwd: appDir, input, encoding: "utf8", stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
}

if (!force) {
  const list = wrangler(["secret", "list", "--format", "json"]);
  if (list.status === 0 && /"VAPID_PUBLIC_KEY"/.test(list.stdout)) {
    console.error("[push:keys] VAPID_PUBLIC_KEY は登録済みです。作り直すと既存の購読が使えなくなります（作り直すなら --force）。");
    process.exit(1);
  }
}

const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const { d: privateKey } = await webcrypto.subtle.exportKey("jwk", kp.privateKey);

for (const [name, value] of [
  ["VAPID_PRIVATE_KEY", privateKey],
  ["VAPID_PUBLIC_KEY", publicKey],
]) {
  const r = wrangler(["secret", "put", name], value);
  if (r.status !== 0) {
    console.error(`[push:keys] ${name} の登録に失敗しました: ${(r.stderr || r.stdout).trim()}`);
    process.exit(1);
  }
  console.log(`[push:keys] ${name} を登録しました`);
}
console.log("[push:keys] 完了。公開鍵は GET /api/session の vapidPublicKey で配られます。");
