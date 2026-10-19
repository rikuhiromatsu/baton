#!/usr/bin/env node
// 本番のビルド成果物（app/dist/**）に E2E 用のものが混ざっていないことを確かめる（v1 設計書 6.5・D-15、DESIGN-v2 15.1）。
// `npm run deploy` の最初（ビルドの直後）と CI で実行する。見つかったら exit 1 でデプロイを止める。
//
// 見るもの:
//   - テスト用ログインの迂回: "/api/test/"・"E2E_TEST_SECRET"・e2e の秘密の値・"X-Baton-Test-Secret"
//   - 偽 claude（tools/fake-claude）とその環境変数: "fake-claude"・"FAKE_CLAUDE_"
//   - e2e の環境のビルド: wrangler.json の "BATON_ENV": "e2e"、e2e の D1（baton-e2e）、偽のプッシュサービスへの送信を許す設定（allowE2E: true）
//   - 秘密のファイル: .dev.vars*（e2e 用を含む）が成果物に入っていない
// 偽のプッシュサービスのオリジン（http://localhost:8799）の文字列そのものは、送り先の検査（isAllowedPushEndpoint）の定数として
// 本番の Worker にも入る（e2e の環境でだけ allowE2E で有効になる）ので見ない。代わりに allowE2E が真で呼ばれていないことを見る。
//
// 使い方: node scripts/assert-no-test-routes.mjs [dist のパス]（既定は app/dist）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "app/dist"));

/** [名前, 探す文字列か正規表現] */
const NEEDLES = [
  ["テスト用ログインのパス", "/api/test/"],
  ["テスト用の秘密の名前", "E2E_TEST_SECRET"],
  ["テスト用の秘密の値", "e2e-local-secret"],
  ["テスト用の秘密のヘッダ", "X-Baton-Test-Secret"],
  ["偽 claude", "fake-claude"],
  ["偽 claude の環境変数", "FAKE_CLAUDE_"],
  ["e2e の環境の変数", /"BATON_ENV"\s*:\s*"e2e"/],
  ["e2e の D1", /"database_name"\s*:\s*"baton-e2e"/],
  ["偽のプッシュサービスへの送信の許可", /allowE2E\s*:\s*(?:!0|true)\b/],
];
const SECRET_FILE = /^\.dev\.vars/;

if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
  console.error(`[assert-no-test-routes] ${path.relative(repoRoot, distDir) || distDir} がありません。先に npm run build を実行してください`);
  process.exit(1);
}

/** 隠しファイル（.dev.vars 等）も含めて全部見る */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function* occurrences(text, needle) {
  if (typeof needle === "string") {
    let from = 0;
    let idx;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      yield { idx, len: needle.length };
      from = idx + needle.length;
    }
    return;
  }
  const re = new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`);
  for (const m of text.matchAll(re)) yield { idx: m.index ?? 0, len: m[0].length };
}

const hits = [];
let scanned = 0;
for (const file of walk(distDir)) {
  scanned++;
  const rel = path.relative(repoRoot, file);
  if (SECRET_FILE.test(path.basename(file))) {
    hits.push({ file: rel, name: "秘密のファイル（.dev.vars*）", line: 0, around: path.basename(file) });
    continue;
  }
  // バイナリ（画像など）も latin1 で読めば ASCII の文字列は見つかる
  const text = fs.readFileSync(file).toString("latin1");
  for (const [name, needle] of NEEDLES) {
    for (const { idx, len } of occurrences(text, needle)) {
      const line = text.slice(0, idx).split("\n").length;
      const around = text.slice(Math.max(0, idx - 40), idx + len + 40).replace(/\s+/g, " ");
      hits.push({ file: rel, name, line, around });
      if (hits.length > 200) break;
    }
  }
}

if (hits.length > 0) {
  console.error(`[assert-no-test-routes] テスト用のものがビルド成果物に含まれています（${hits.length} 件）。デプロイを中止します。`);
  for (const h of hits.slice(0, 50)) console.error(`  ${h.file}:${h.line}  ${h.name}  …${h.around}…`);
  console.error(
    "  e2e 用のビルド（CLOUDFLARE_ENV=e2e vite build --mode e2e）の成果物が残っていないか、テスト用ルート・偽 claude の参照が本番ビルドに入っていないかを確かめてください。",
  );
  process.exit(1);
}

console.log(`[assert-no-test-routes] OK: ${scanned} ファイルにテスト用のものはありません（${NEEDLES.map(([n]) => n).join("・")}・.dev.vars*）`);
