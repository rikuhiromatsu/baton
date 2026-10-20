// Jev の見本 3 件の確認（`npm run jev:probe -w runner`。DESIGN-v2 5.9.1・15.4 の 9-3）。
// 本物の TypeSafe に 3 回だけ問い合わせ（入力トークンだけ課金）、判定と振り分けを表で出す。claude は起動しない。
// 鍵は出どころ（env / settings / none）だけ表示する。設定は BATON_ENV_FILE か環境変数の BATON_JEV_*・BATON_TYPESAFE_*。
import { HttpJevClient } from "../src/claude/jev.ts";
import { DEFAULT_TIERS, buildJevState, clampRouting, describeDecision, route, ASSUMED_DEFAULT_EFFORT, type Effort } from "../src/claude/jev-policy.ts";
import { loadConfig } from "../src/config.ts";
import { getProfile, loadProfiles } from "../src/claude/profiles.ts";

const SAMPLES = [
  { label: "機械的", profileId: "generalist", title: "hello.txt に 1 行書く", spec: "hello.txt に「こんにちは」と 1 行だけ書く。完了の条件: hello.txt があり、中身が 1 行。", paths: ["hello.txt"] },
  { label: "普通", profileId: "engineer", title: "日付の整形関数にテストを足す", spec: "src/format.ts の formatDate() に、境界（月末・うるう年・タイムゾーン）のテストを足し、見つかった不具合を直す。完了の条件: npm test が通る。", paths: ["src/format.ts", "src/format.test.ts"] },
  { label: "難しい", profileId: "engineer", title: "同時実行で壊れる在庫引当の原因調査", spec: "本番で時々、在庫がマイナスになる。原因は不明。トランザクションの分離レベルとロックの取り方を調べ、再現するテストを書いたうえで、データを壊さない修正とマイグレーション手順を設計して実装する。", paths: ["src/inventory/", "migrations/"] },
] as const;

async function main(): Promise<void> {
  const config = loadConfig({ BATON_URL: "http://localhost", BATON_RUNNER_TOKEN: "probe", ...process.env });
  const client = new HttpJevClient({ baseUrl: config.jev.baseUrl, model: config.jev.model, timeoutMs: Math.max(config.jev.timeoutMs, 10_000), envKey: config.jev.apiKey, home: config.home });
  const profiles = await loadProfiles(config);
  console.log(`Jev の見本確認: ${config.jev.baseUrl}（モデル ${config.jev.model}）／鍵の出どころ: ${client.status().keySource}`);
  if (client.status().keySource === "none") {
    console.error("鍵がありません（BATON_TYPESAFE_API_KEY か ~/.claude/settings.json の jev-model-router）。問い合わせは出しません。");
    process.exitCode = 1;
    return;
  }
  const rows: Record<string, string>[] = [];
  for (const s of SAMPLES) {
    const profile = getProfile(profiles, s.profileId);
    const state = buildJevState({ title: s.title, spec: s.spec, paths: s.paths, profileId: s.profileId, workspaceKind: "baton", round: 1, conflictResolution: false, dependsOn: 0, maxTurns: config.limits.maxTurns.member });
    const r = await client.decide(state as unknown as Record<string, unknown>);
    if (!r.decision || !profile.jev) {
      rows.push({ 見本: s.label, 職種: s.profileId, 判定: `聞けず（${r.error ?? "bad_body"}）`, ms: String(r.ms), 振り分け: "-", 理由: "-" });
      continue;
    }
    const baseEffort = (profile.effort ?? null) as Effort | null;
    const routing = route(r.decision, { model: profile.model, effort: baseEffort ?? ASSUMED_DEFAULT_EFFORT }, { tiers: DEFAULT_TIERS, minUpgradeConfidence: config.jev.minUpgradeConfidence, minDowngradeConfidence: config.jev.minDowngradeConfidence });
    const clamp = clampRouting({ routing, base: { model: profile.model, effort: baseEffort }, limits: profile.jev, conflictResolution: false, quota: { fiveHour: null, sevenDay: null }, quotaThresholds: config.jev.upgradeQuota });
    rows.push({
      見本: s.label,
      職種: s.profileId,
      判定: describeDecision(r.decision, null),
      ms: String(r.ms),
      振り分け: `${clamp.model}${clamp.effort ? `/${clamp.effort}` : ""}`,
      理由: `${routing.reason}${clamp.clamped.length ? `／上限: ${clamp.clamped.join("、")}` : ""}`,
    });
  }
  console.table(rows);
}

main().catch((err: unknown) => {
  // 鍵・本文は出さない
  console.error(`失敗しました: ${(err as Error).message}`);
  process.exit(1);
});
