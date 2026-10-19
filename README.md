# Baton

CEO（人間）が出した指示を、AI の COO が受け取り、プロジェクトごとのチームリーダーに渡し、リーダーがメンバーに振って実行させ、結果を要約しながら上へ返すアプリです。

```
CEO ──指示──▶ COO ──方針──▶ リーダー（プロジェクトごと） ──タスク──▶ メンバー
 ▲                │                │                                │
 └── 最終報告 ◀───┴──── 要約 ◀─────┴────────── 結果の要約 ◀─────────┘
```

- 開いた瞬間に COO へ指示できる（入力欄は HTML に埋め込み、JS の読み込みを待たない）
- 指示はフリックで状態を動かす（確認を右で承認・左で差し戻し、など。5 秒間は取り消せる）
- 白ベースの Liquid Glass UI、全画面スケルトン、PWA（iPhone のホーム画面に追加できる）

本番: https://baton.rikuhiromatsu.workers.dev （Google ログイン。許可したアカウントだけが使える）

## しくみ

| 層 | 役割 |
|---|---|
| Cloudflare Workers（Hono）＋ 静的アセット | 画面配信・API・Google 認証・セッション |
| D1 | 指示・タスク・ログ・成果物の目録の正本 |
| Durable Objects（Hibernation WebSocket） | ブラウザとランナーへのリアルタイム配信 |
| Workers AI | 推論（COO: gpt-oss-120b、リーダー・メンバー: glm-4.7-flash） |
| Mac mini のランナー（Node 26、launchd） | COO → リーダー → メンバーのループ、作業フォルダでのファイル操作・Web 取得 |
| Tailscale | 端末 ↔ Mac mini の私設経路。成果物ファイル・生ログ・状態を tailnet の中だけに出す |

Mac mini は外に穴を開けず、Cloudflare へ外向きに接続するだけです。AI は Worker 経由で呼ぶので、Mac mini に API キーを置きません。技術の選定理由・却下した案・データモデル・API・UI 仕様・決定ログはすべて [docs/DESIGN.md](docs/DESIGN.md) にあります。

## ディレクトリ

```
packages/shared  契約（状態遷移・API の型・イベント・AI の行動形式・上限・testid・固定文言）
app              Cloudflare Worker（src/worker）と画面（src/web）。1 つの Vite プロジェクト
runner           Mac mini で常駐するランナー
e2e              Playwright（デスクトップ Chrome・iPhone 相当の Chromium と WebKit）
docs             設計書と D1 スキーマ
scripts          デプロイ前の検査・本番スモーク・Mac mini のセットアップ
```

## 開発

```bash
npm install
cp app/.dev.vars.example app/.dev.vars        # 値を入れる
cp app/.dev.vars.e2e.example app/.dev.vars.e2e
npm run dev                                   # http://localhost:8790
```

画面だけを触るなら `http://localhost:8790/?mock=1`（API なしのモック）が使えます。

## テスト

```bash
npm run typecheck
npm run test:unit                 # shared・web・runner（Vitest）
npm run test:worker -w app        # Worker の統合テスト（workerd 上の D1・DO）
npx playwright install chromium webkit
npm run test:e2e                  # E2E（AI は台本どおりに答えるモック）
```

## デプロイ

Mac mini から wrangler のログインで行います。

```bash
npm run deploy    # ビルド → テスト用ルートの混入検査 → D1 のマイグレーション → wrangler deploy → 本番スモーク
```

初回だけ、シークレット（`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`ALLOWED_EMAILS`）を `wrangler secret` で登録します。

## Mac mini のセットアップ

```bash
scripts/setup-mini.sh
```

ランナーの登録（トークンは `~/.config/baton/runner.env` に権限 600 で保存）、launchd への常駐、`tailscale serve` をまとめて行います。ランナーを更新したら `launchctl kickstart -k gui/$(id -u)/com.rikuhiromatsu.baton-runner` で再起動します。
