#!/usr/bin/env bash
# Builds and switches DM-me releases. Each version is built in its own folder while the running
# one is left alone; the site moves over only once the build is done, and moves straight back
# if the new version doesn't come up. Run by setup.sh as root.
#
#   release.sh build <source dir>    build a release (or reuse one already built for that commit);
#                                     prints its folder on the last line of output
#   release.sh activate <release>    point `current` at it, restart, check health; on failure
#                                     switch back to the previous release and exit non-zero
#
# Settings (environment): RELEASES (/opt/dm-me-releases), SERVICE (dm-me.service),
# APP_USER (dmme), PORT (3000), KEEP (3 releases kept, besides the running one).
set -euo pipefail

RELEASES=${RELEASES:-/opt/dm-me-releases}
CURRENT=$RELEASES/current
SERVICE=${SERVICE:-dm-me.service}
APP_USER=${APP_USER:-dmme}
PORT=${PORT:-3000}
KEEP=${KEEP:-3}

die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

git_() { git -C "$1" -c safe.directory="$1" "${@:2}"; }

build() {
  local src=$1 rev id tmp existing
  install -d -m 755 "$RELEASES"
  rev=$(git_ "$src" rev-parse --short=12 HEAD 2>/dev/null || echo unversioned)
  # Uncommitted changes make a one-off build; a clean commit that was built before is reused.
  if [[ $rev == unversioned || -n $(git_ "$src" status --porcelain --untracked-files=no 2>/dev/null) ]]; then
    rev+=-local
  else
    existing=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name "*-$rev" | sort | tail -n1)
    if [[ -n $existing && -f $existing/.built ]]; then
      echo "Already built: $(basename "$existing")" >&2
      echo "$existing"
      return
    fi
  fi
  id="$(date -u +%Y%m%d-%H%M%S)-$rev"
  tmp="$RELEASES/.building-$id"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp"
  tar -C "$src" --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./data \
    --exclude=./test-results -cf - . | tar -C "$tmp" -xf -
  (
    cd "$tmp"
    npm ci --no-audit --no-fund --loglevel=error
    npm run build --silent
    npm prune --omit=dev --no-audit --no-fund --loglevel=error
  ) >&2
  chmod 755 "$tmp"
  runuser -u "$APP_USER" -- test -r "$tmp/dist/server/index.js" ||
    die "The service user can't read $tmp. Make sure every folder on that path is readable (chmod o+rx)."
  touch "$tmp/.built"
  mv "$tmp" "$RELEASES/$id"
  trap - EXIT
  echo "$RELEASES/$id"
}

# Points `current` at a release in one step, so the service never sees a half-switched link.
point_at() {
  ln -sfn "$1" "$CURRENT.next"
  mv -T "$CURRENT.next" "$CURRENT"
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"app":"dm-me"'; then return 0; fi
    sleep 1
  done
  return 1
}

# Keeps the newest $KEEP releases plus the running and previous ones; removes the rest.
prune() {
  local keep_now=$1 keep_prev=$2 dir n=0
  while IFS= read -r dir; do
    n=$((n + 1))
    [[ $dir == "$keep_now" || $dir == "$keep_prev" || $n -le $KEEP ]] && continue
    rm -rf "$dir"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | sort -r)
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '.building-*' -mmin +60 -exec rm -rf {} +
}

activate() {
  local new prev=''
  new=$(readlink -f "$1")
  [[ -f $new/.built ]] || die "$1 isn't a finished release."
  [[ -L $CURRENT ]] && prev=$(readlink -f "$CURRENT")
  point_at "$new"
  systemctl restart "$SERVICE"
  if healthy; then
    prune "$new" "$prev"
    echo "Running $(basename "$new")."
    return 0
  fi
  journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
  if [[ -z $prev || $prev == "$new" ]]; then
    die "The new version didn't start (its log is above), and there's no earlier release to go back to."
  fi
  echo "The new version didn't start (its log is above). Going back to $(basename "$prev")..." >&2
  point_at "$prev"
  systemctl restart "$SERVICE"
  if healthy; then
    die "Rolled back: the site is running the previous version, $(basename "$prev"), again."
  fi
  die "Rolled back to $(basename "$prev"), but it isn't answering either. Check: journalctl -u $SERVICE -n 50"
}

case "${1:-}" in
  build) build "${2:?source directory}" ;;
  activate) activate "${2:?release folder}" ;;
  *) die "Usage: $0 build <source dir> | activate <release folder>" ;;
esac
