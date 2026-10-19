#!/usr/bin/env node
// 本番のビルド成果物（app/dist/**）に E2E 用のログイン迂回が混ざっていないことを確かめる（設計書 6.5・D-15）。
// `npm run deploy` の最初（ビルドの直後）に実行する。見つかったら exit 1 でデプロイを止める。
//
// 使い方: node scripts/assert-no-test-routes.mjs [dist のパス]（既定は app/dist）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "app/dist"));
const NEEDLES = ["/api/test/", "E2E_TEST_SECRET"];

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

const hits = [];
let scanned = 0;
for (const file of walk(distDir)) {
  scanned++;
  // バイナリ（画像など）も latin1 で読めば ASCII の文字列は見つかる
  const text = fs.readFileSync(file).toString("latin1");
  for (const needle of NEEDLES) {
    let from = 0;
    let idx;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      const line = text.slice(0, idx).split("\n").length;
      const around = text.slice(Math.max(0, idx - 40), idx + needle.length + 40).replace(/\s+/g, " ");
      hits.push({ file: path.relative(repoRoot, file), needle, line, around });
      from = idx + needle.length;
      if (hits.length > 200) break;
    }
  }
}

if (hits.length > 0) {
  console.error(`[assert-no-test-routes] テスト用の文字列がビルド成果物に含まれています（${hits.length} 件）。デプロイを中止します。`);
  for (const h of hits.slice(0, 50)) console.error(`  ${h.file}:${h.line}  "${h.needle}"  …${h.around}…`);
  console.error("  e2e 用のビルド（CLOUDFLARE_ENV=e2e vite build --mode e2e）の成果物が残っていないか、テスト用ルートが本番ビルドに入っていないかを確かめてください。");
  process.exit(1);
}

console.log(`[assert-no-test-routes] OK: ${scanned} ファイルにテスト用の文字列はありません（${NEEDLES.join("、")}）`);
