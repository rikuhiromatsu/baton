#!/bin/zsh
# Mac mini の初期設定をまとめて行う（設計書 9.4）。何度実行してもよい。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
cd "$REPO"

echo "1/5 依存を入れる"
npm ci

echo "2/5 フォルダを作る"
mkdir -p ~/baton-data/projects ~/Library/Logs/baton ~/.config/baton

echo "3/5 ランナーを登録する（済みなら飛ばす）"
if [[ -f ~/.config/baton/runner.env ]]; then
  echo "  ~/.config/baton/runner.env があるので登録は飛ばします（再発行は npm run register -w runner）"
else
  npm run register -w runner
fi

echo "4/5 launchd に常駐させる"
npm run install-agent -w runner

echo "5/5 tailnet に公開する（tailscale serve）"
if "$TAILSCALE" serve --bg --https=443 http://127.0.0.1:7777; then
  "$TAILSCALE" serve status
else
  echo "  tailscale serve に失敗しました。Tailscale 管理画面（https://login.tailscale.com/admin/dns）で HTTPS Certificates を有効にしてから、もう一度実行してください" >&2
fi

sleep 2
curl -fsS -H "Tailscale-User-Login: $(grep '^ALLOWED_TAILNET_LOGINS=' ~/.config/baton/runner.env | cut -d= -f2 | cut -d, -f1)" http://127.0.0.1:7777/status && echo
echo "完了"
