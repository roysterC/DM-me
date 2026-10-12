#!/usr/bin/env bash
# Restores the latest database backup from the bucket into a scratch file and checks it against
# the live database: that it restores at all, passes an integrity check, and isn't falling
# behind. Writes the result to $DATA_DIR/backup-check.json, which the admin page shows.
# Runs daily from dm-me-backup-check.timer (as the app user); run it by hand any time:
#
#   sudo systemctl start dm-me-backup-check && journalctl -u dm-me-backup-check -n 20
#
# Settings (environment): DATA_DIR (/var/lib/dm-me), CONFIG (/etc/dm-me/litestream.yml),
# LITESTREAM (litestream), NODE (node), APP (/opt/dm-me-releases/current, for its node_modules).
set -euo pipefail

DATA_DIR=${DATA_DIR:-/var/lib/dm-me}
CONFIG=${CONFIG:-/etc/dm-me/litestream.yml}
LITESTREAM=${LITESTREAM:-litestream}
APP=${APP:-/opt/dm-me-releases/current}
NODE=${NODE:-node}
LIVE=$DATA_DIR/dm-me.sqlite
RESULT=$DATA_DIR/backup-check.json

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

report() { # ok, message
  "$NODE" -e 'const fs = require("fs"); const [file, ok, message, extra] = process.argv.slice(1);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ checkedAt: new Date().toISOString(), ok: ok === "true", message, ...JSON.parse(extra || "{}") }));
    fs.renameSync(file + ".tmp", file);' "$RESULT" "$1" "$2" "${3:-}"
  echo "$2"
}

if ! "$LITESTREAM" restore -config "$CONFIG" -if-replica-exists -integrity-check quick -o "$scratch/restored.sqlite" "$LIVE" >"$scratch/restore.log" 2>&1; then
  cat "$scratch/restore.log" >&2
  report false "Restoring the backup failed: $(grep -m1 -iE 'error|fail' "$scratch/restore.log" | cut -c1-200 || echo 'see journalctl -u dm-me-backup-check')"
  exit 1
fi
if [[ ! -f $scratch/restored.sqlite ]]; then
  report false "There's no backup in the bucket yet. Is dm-me-backup running? (journalctl -u dm-me-backup)"
  exit 1
fi

# Compare with the live database: the copy should be at most a few minutes behind it.
summary=$("$NODE" -e '
  const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
  const open = (f) => new Database(f, { readonly: true, fileMustExist: true });
  const facts = (db) => ({
    version: db.pragma("user_version", { simple: true }),
    messages: db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
    newest: db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE created_at <= ?").get(new Date().toISOString()).t,
  });
  const live = facts(open(process.argv[2]));
  const copy = facts(open(process.argv[3]));
  const behindMin = live.newest && copy.newest ? Math.round((Date.parse(live.newest) - Date.parse(copy.newest)) / 60000) : 0;
  console.log(JSON.stringify({ live, copy, behindMin }));
' "$APP" "$LIVE" "$scratch/restored.sqlite")

behind=$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).behindMin)' "$summary")
messages=$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).copy.messages)' "$summary")
if ((behind > 30)); then
  report false "The backup is ${behind} minutes behind the live chats: backups seem stuck. Check journalctl -u dm-me-backup." "$summary"
  exit 1
fi
report true "The latest backup restores cleanly (${messages} messages)." "$summary"
