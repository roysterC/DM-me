#!/usr/bin/env bash
# Restore drill, run in CI: streams a live app's database to a local replica with Litestream
# (the version deploy/setup.sh installs) while chats happen, then runs deploy/backup-check.sh
# against it, the way servers check their real backups every day.
#
#   npm run build && scripts/backup-drill.sh
#
# Uses LITESTREAM if set; otherwise downloads the pinned Litestream and checks its checksum.
set -euo pipefail
cd "$(dirname "$0")/.."

work=$(mktemp -d)
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

if [[ -z ${LITESTREAM:-} ]]; then
  version=$(sed -n 's/^LITESTREAM_VERSION=//p' deploy/setup.sh)
  sum=$(sed -n 's/^ *\[x86_64\]=\([0-9a-f]\{64\}\)$/\1/p' deploy/setup.sh | head -n1)
  curl -fsSL -o "$work/litestream.deb" \
    "https://github.com/benbjohnson/litestream/releases/download/v${version}/litestream-${version}-linux-x86_64.deb"
  echo "$sum  $work/litestream.deb" | sha256sum -c --quiet -
  dpkg-deb -x "$work/litestream.deb" "$work/litestream"
  LITESTREAM=$work/litestream/usr/bin/litestream
fi
echo "Litestream $("$LITESTREAM" version)"

port=3457
base=http://127.0.0.1:$port
mkdir -p "$work/data"
DATA_DIR=$work/data DM_ME_FAKE_AI=1 TYPING_SPEED=0 PORT=$port HOST=127.0.0.1 node dist/server/index.js >"$work/app.log" 2>&1 &
for _ in $(seq 1 30); do curl -fs "$base/api/health" >/dev/null && break; sleep 1; done

cat >"$work/litestream.yml" <<EOF
dbs:
  - path: $work/data/dm-me.sqlite
    replica:
      type: file
      path: $work/replica
EOF
"$LITESTREAM" replicate -config "$work/litestream.yml" >"$work/litestream.log" 2>&1 &

# Some chatting while the backup streams.
api() { curl -fsS -b "$work/jar" -c "$work/jar" -H "origin: $base" -H 'content-type: application/json' "$@" >/dev/null; }
for i in 1 2 3 4 5; do
  api -d "{\"text\":\"drill message $i\"}" "$base/api/chat/messages"
  api -d '{}' "$base/api/chat/reply"
done
sleep 5

if ! DATA_DIR=$work/data CONFIG=$work/litestream.yml LITESTREAM=$LITESTREAM APP=$PWD deploy/backup-check.sh; then
  tail -n 20 "$work/litestream.log" >&2
  exit 1
fi
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const r = require(process.argv[1]);
  if (!r.ok || r.copy.messages !== 10 || r.copy.messages !== r.live.messages) {
    console.error("The restored copy does not match:", JSON.stringify(r));
    process.exit(1);
  }
  console.log("Restore drill passed: " + r.copy.messages + " messages restored, schema version " + r.copy.version + ".");
' "$work/data/backup-check.json"
