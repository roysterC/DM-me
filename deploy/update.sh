#!/usr/bin/env bash
# Pulls the latest code and redeploys it.
#
#   sudo /opt/dm-me/deploy/update.sh             # update to the latest commit
#   sudo /opt/dm-me/deploy/update.sh --no-pull   # rebuild what's checked out (e.g. after a rollback)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "Run this as root: sudo $0" >&2; exit 1; }

git_() { git -C "$APP_DIR" -c safe.directory="$APP_DIR" "$@"; }

before=$(git_ rev-parse --short HEAD)
if [[ ${1:-} != --no-pull ]]; then
  git_ pull --ff-only
fi
after=$(git_ rev-parse --short HEAD)
echo "Deploying $after (was $before)"

if ! "$APP_DIR/deploy/setup.sh"; then
  cat >&2 <<EOF

The update failed. To go back to the version that was running before:
  sudo git -C $APP_DIR checkout $before
  sudo $APP_DIR/deploy/update.sh --no-pull
Once a fix is pushed, return to the main branch before updating again:
  sudo git -C $APP_DIR checkout main && sudo $APP_DIR/deploy/update.sh
EOF
  exit 1
fi
