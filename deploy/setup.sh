#!/usr/bin/env bash
# Sets up DM-me on a Debian or Ubuntu VPS: Node, Caddy (HTTPS), a systemd service,
# and Litestream backups of the database to your bucket.
#
#   sudo git clone https://github.com/roysterC/DM-me.git /opt/dm-me
#   sudo /opt/dm-me/deploy/setup.sh        # first run creates /etc/dm-me/dm-me.env
#   sudo nano /etc/dm-me/dm-me.env         # fill it in
#   sudo /opt/dm-me/deploy/setup.sh        # second run installs and starts everything
#
# Safe to run again at any time; deploy/update.sh runs it after pulling new code.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR=/etc/dm-me
ENV_FILE=$ENV_DIR/dm-me.env
DATA_DIR=/var/lib/dm-me
APP_USER=dmme
PORT=3000
NODE_MAJOR=22
LITESTREAM_VERSION=0.5.17
declare -A LITESTREAM_SHA256=(
  [x86_64]=a191a0928884d1820fab1f866ede1d0d5811c323d0587bf863a43481a82a7668
  [arm64]=7d34ed3356844fe3dd127462b9f4ea7e79ef14679eadf2fed6c737dcb797358e
)
CADDY_VERSION=2.11.7
declare -A CADDY_SHA512=(
  [amd64]=47e8351c2317b427af14a103e763ca1118a3d2396a88b4c0669cdec9c4a68a957690194e2423a1633f53135741c33a41bdac2b55515b7d0f7adc8b733add50d9
  [arm64]=ac32f03f0eea04021f2d4e5d89bfd01b84ead115f2eba9d2a0d06447e86d4af932899e56f090993a566d0925dbd1063002929b395541a8c5f5e51d7039f7375a
)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Reads KEY from the env file without executing it (passwords may contain $ or spaces).
env_get() {
  local line
  line=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 || true)
  line=${line#*=}
  line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

render() { # template -> destination, replacing @NAME@ placeholders
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@APP_USER@|$APP_USER|g" \
    -e "s|@PORT@|$PORT|g" -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@NODE@|${NODE_BIN:-}|g" \
    -e "s|@LITESTREAM@|${LITESTREAM_BIN:-}|g" "$1" >"$2"
}

[[ $EUID -eq 0 ]] || die "Run this as root: sudo $0"
command -v apt-get >/dev/null || die "This script supports Debian and Ubuntu."
command -v systemctl >/dev/null || die "systemd is required."
case "$APP_DIR" in
  /home/* | /root/*) die "The app is in $APP_DIR, which the service can't read. Clone it to /opt/dm-me instead." ;;
esac

# ---- Settings ------------------------------------------------------------------

if [[ ! -f $ENV_FILE ]]; then
  install -d -m 700 "$ENV_DIR"
  secret=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed "s|^SECRET=.*|SECRET=$secret|" "$APP_DIR/deploy/dm-me.env.example" >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  step "Created $ENV_FILE"
  echo "Fill it in (domain, Anthropic key, admin password, bucket), then run this script again:"
  echo "  sudo nano $ENV_FILE"
  exit 0
fi

DOMAIN=$(env_get DOMAIN)
if [[ -z $DOMAIN || $DOMAIN == chat.example.com ]]; then
  ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  if [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "Set DOMAIN in $ENV_FILE. No domain? Use this server's free nip.io address:
  DOMAIN=${ip//./-}.nip.io"
  fi
  die "Set DOMAIN in $ENV_FILE. No domain? Use <your server's IP with dashes>.nip.io, e.g. 203-0-113-10.nip.io"
fi
[[ -n $(env_get SECRET) ]] || die "SECRET is empty in $ENV_FILE. Delete the file and run setup again to regenerate it."
[[ -n $(env_get ANTHROPIC_API_KEY) ]] || warn "ANTHROPIC_API_KEY is empty: the site works but Nova won't reply."
[[ -n $(env_get ADMIN_PASSWORD) ]] || warn "ADMIN_PASSWORD is empty: the /admin page will be off."
BACKUPS=no
if [[ -n $(env_get S3_BUCKET) ]]; then
  for k in S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    [[ -n $(env_get "$k") && $(env_get "$k") != *"<account id>"* ]] || die "S3_BUCKET is set, so $k needs a real value too. Fix $ENV_FILE."
  done
  [[ -n $(env_get S3_REGION) ]] || die "Set S3_REGION in $ENV_FILE (use auto for Cloudflare R2)."
  BACKUPS=yes
else
  warn "No bucket configured: photos stay on this server's disk and the database is NOT backed up."
fi

# ---- Ports 80 and 443 must be free for Caddy ---------------------------------------

if command -v ss >/dev/null; then
  others=$(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)
  [[ -z $others ]] || die "Something other than Caddy is using port 80 or 443 (nginx or Apache?):
$others
Stop it, or put DM-me behind it yourself (proxy to 127.0.0.1:$PORT) and skip Caddy."
fi

# ---- Packages ---------------------------------------------------------------------

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
# Earlier versions of this script added Caddy's Cloudsmith apt repository, which now answers
# "402 Payment Required" and breaks every apt-get update. Remove it if it's there.
if grep -qs 'dl.cloudsmith.io/public/caddy' /etc/apt/sources.list.d/caddy-stable.list; then
  rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg >/dev/null

node_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [[ ${node_major:-0} -lt $NODE_MAJOR ]]; then
  step "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  rm -f /tmp/nodesource_setup.sh
fi
NODE_BIN=$(command -v node)
echo "Node $(node -v)"

if ! command -v caddy >/dev/null; then
  # Straight from Caddy's GitHub releases (checksum-verified), not an apt repository.
  step "Installing Caddy $CADDY_VERSION"
  arch=$(dpkg --print-architecture)
  [[ -n ${CADDY_SHA512[$arch]:-} ]] || die "No Caddy package for $arch. Install Caddy yourself, then run setup again."
  deb="caddy_${CADDY_VERSION}_linux_${arch}.deb"
  curl -fsSL -o "/tmp/$deb" "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/$deb"
  echo "${CADDY_SHA512[$arch]}  /tmp/$deb" | sha512sum -c --quiet - || die "Caddy download failed its checksum."
  dpkg -i "/tmp/$deb" >/dev/null
  rm -f "/tmp/$deb"
fi

if [[ $BACKUPS == yes ]] && ! litestream version 2>/dev/null | grep -q "$LITESTREAM_VERSION"; then
  step "Installing Litestream $LITESTREAM_VERSION"
  case "$(dpkg --print-architecture)" in
    amd64) arch=x86_64 ;;
    arm64) arch=arm64 ;;
    *) die "Litestream has no package for $(dpkg --print-architecture). Remove S3_BUCKET to run without backups." ;;
  esac
  deb="litestream-${LITESTREAM_VERSION}-linux-${arch}.deb"
  curl -fsSL -o "/tmp/$deb" "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$deb"
  echo "${LITESTREAM_SHA256[$arch]}  /tmp/$deb" | sha256sum -c --quiet - || die "Litestream download failed its checksum."
  dpkg -i "/tmp/$deb" >/dev/null
  rm -f "/tmp/$deb"
  # The package ships its own service for /etc/litestream.yml; ours runs instead.
  systemctl disable --now litestream.service >/dev/null 2>&1 || true
fi
LITESTREAM_BIN=$(command -v litestream || true)

# ---- User and data directory --------------------------------------------------------

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$DATA_DIR"

# ---- Build ---------------------------------------------------------------------------

step "Building the app"
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if ((mem_mb + swap_mb < 900)); then
  warn "Only ${mem_mb} MB of memory and ${swap_mb} MB of swap. If the build gets killed, add 1 GB of swap (see deploy/README.md)."
fi
cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
npm prune --omit=dev --no-audit --no-fund --loglevel=error
runuser -u "$APP_USER" -- test -r "$APP_DIR/dist/server/index.js" ||
  die "The service user can't read $APP_DIR. Make sure every folder on that path is readable (chmod o+rx)."

# ---- Restore the database from the bucket on a fresh server -----------------------------

if [[ $BACKUPS == yes ]]; then
  render "$APP_DIR/deploy/litestream.yml" "$ENV_DIR/litestream.yml"
  chown root:"$APP_USER" "$ENV_DIR/litestream.yml"
  chmod 640 "$ENV_DIR/litestream.yml"
  if [[ ! -f $DATA_DIR/dm-me.sqlite ]]; then
    step "Looking for a backup to restore"
    systemctl stop dm-me.service 2>/dev/null || true
    systemd-run --quiet --wait --pipe --collect -p User="$APP_USER" -p EnvironmentFile="$ENV_FILE" \
      "$LITESTREAM_BIN" restore -config "$ENV_DIR/litestream.yml" -if-db-not-exists -if-replica-exists \
      -integrity-check quick "$DATA_DIR/dm-me.sqlite"
    if [[ -f $DATA_DIR/dm-me.sqlite ]]; then echo "Restored the database from the bucket."; else echo "No backup yet: starting fresh."; fi
  fi
fi

# ---- Services --------------------------------------------------------------------------

step "Starting DM-me"
render "$APP_DIR/deploy/dm-me.service" /etc/systemd/system/dm-me.service
if [[ $BACKUPS == yes ]]; then
  render "$APP_DIR/deploy/dm-me-backup.service" /etc/systemd/system/dm-me-backup.service
fi
systemctl daemon-reload
systemctl enable --quiet dm-me.service
systemctl restart dm-me.service

healthy=no
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/admin/me"; then healthy=yes; break; fi
  sleep 1
done
if [[ $healthy != yes ]]; then
  journalctl -u dm-me.service -n 30 --no-pager >&2 || true
  die "DM-me didn't start. The log is above."
fi

if [[ $BACKUPS == yes ]]; then
  systemctl enable --quiet dm-me-backup.service
  systemctl restart dm-me-backup.service
elif [[ -f /etc/systemd/system/dm-me-backup.service ]]; then
  systemctl disable --now dm-me-backup.service >/dev/null 2>&1 || true
fi

# ---- HTTPS with Caddy ---------------------------------------------------------------------

step "Configuring HTTPS for $DOMAIN"
install -d /etc/caddy/sites
render "$APP_DIR/deploy/Caddyfile" /etc/caddy/sites/dm-me.caddy
if ! grep -q 'import /etc/caddy/sites/\*' /etc/caddy/Caddyfile 2>/dev/null; then
  if [[ ! -f /etc/caddy/Caddyfile ]] || grep -q 'easy way to configure your Caddy' /etc/caddy/Caddyfile; then
    # The package's placeholder config: replace it.
    [[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
    echo 'import /etc/caddy/sites/*.caddy' >/etc/caddy/Caddyfile
  else
    # Your own config: keep it and add DM-me alongside.
    printf '\nimport /etc/caddy/sites/*.caddy\n' >>/etc/caddy/Caddyfile
  fi
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
  die "Caddy's config is invalid. Check with: caddy validate --config /etc/caddy/Caddyfile"
systemctl enable --quiet caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---- Done ----------------------------------------------------------------------------------

step "Done"
cat <<EOF
DM-me is running at https://$DOMAIN   (admin: https://$DOMAIN/admin)

The HTTPS certificate is issued on the first visit. That needs $DOMAIN to point at this
server and ports 80 and 443 open in any firewall.

Backups:  $([[ $BACKUPS == yes ]] && echo "on, streaming to $(env_get S3_BUCKET)/backups/dm-me" || echo "OFF (no bucket configured)")
Logs:     journalctl -u dm-me -f
Restart:  sudo systemctl restart dm-me
Update:   sudo $APP_DIR/deploy/update.sh
EOF
