#!/usr/bin/env bash
# Updates DM-me to new code and redeploys it.
#
#   sudo /opt/dm-me/deploy/update.sh             # update to the latest commit on main
#   sudo /opt/dm-me/deploy/update.sh --no-pull   # rebuild what's checked out (e.g. after a rollback)
#
# Automatic deploys from GitHub Actions log in with a key that can only run this script, and say
# which commit they tested as SSH_ORIGINAL_COMMAND="deploy <sha>". Exactly that commit is
# deployed, never whatever else has reached main since, and only if it's on main.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "Run this as root: sudo $0" >&2; exit 1; }

# One deploy at a time: a manual update and an automatic one would otherwise build over each other.
exec 9>/run/dm-me-deploy.lock
flock -w 900 9 || { echo "Another update is still running; try again when it's done." >&2; exit 1; }
export DM_ME_DEPLOY_LOCKED=1

git_() { git -C "$APP_DIR" -c safe.directory="$APP_DIR" "$@"; }

before=$(git_ rev-parse --short HEAD)
request=${SSH_ORIGINAL_COMMAND:-}
if [[ -n $request ]]; then
  if [[ ! $request =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
    echo "Unknown request. Expected: deploy <40-character commit id>" >&2
    exit 2
  fi
  sha=${BASH_REMATCH[1]}
  git_ fetch --quiet origin main
  if ! git_ merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
    echo "Commit $sha isn't on main; not deploying it." >&2
    exit 1
  fi
  if [[ $(git_ rev-parse HEAD) != "$sha" ]] && git_ merge-base --is-ancestor "$sha" HEAD; then
    echo "A newer commit ($before) is already deployed; nothing to do for ${sha:0:7}."
    exit 0
  fi
  git_ merge --ff-only --quiet "$sha"
elif [[ ${1:-} != --no-pull ]]; then
  git_ pull --ff-only
fi
after=$(git_ rev-parse --short HEAD)
echo "Deploying $after (was $before)"

if ! "$APP_DIR/deploy/setup.sh"; then
  cat >&2 <<EOF

The update failed; the messages above say where. The site is still running the version it was
running before (a new version that doesn't start is rolled back automatically).
Once a fix is pushed, run: sudo $APP_DIR/deploy/update.sh
EOF
  exit 1
fi
