#!/usr/bin/env bash
#
# auto-deploy: deploy pay.agent when main moves. Run from root's crontab:
#
#   */2 * * * * /opt/pay.agent/bin/auto-deploy.sh >> /var/log/pay-agent-deploy.log 2>&1
#
# Fetches origin/main; when it differs from what is checked out, checks it out
# (detached, so a pull never needs a branch) and runs bin/install.sh, which
# hands the vault unlocks to the new process. A failed install is retried only
# when a newer commit lands, so a broken commit is not redeployed every tick.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${PAYAGENT_DEPLOY_STATE:-/var/lib/pay-agent-deploy}"
mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || exit 0

cd "$DIR"
git fetch -q origin main
want="$(git rev-parse origin/main)"
have="$(git rev-parse HEAD)"
[ "$want" = "$have" ] && exit 0
[ "$(cat "$STATE/failed" 2>/dev/null)" = "$want" ] && exit 0

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "$(stamp) deploying ${want:0:7} (was ${have:0:7})"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$(stamp) refusing: local edits in $DIR"
  echo "$want" > "$STATE/failed"
  exit 1
fi
git checkout -q --detach "$want"
if ./bin/install.sh; then
  rm -f "$STATE/failed"
  echo "$(stamp) deployed ${want:0:7}"
else
  echo "$want" > "$STATE/failed"
  echo "$(stamp) install failed for ${want:0:7}; waiting for a newer commit"
  exit 1
fi
