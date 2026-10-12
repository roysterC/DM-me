#!/usr/bin/env bash
# Run once on the server (as root) to let GitHub Actions deploy DM-me here:
#
#   sudo /opt/dm-me/deploy/enable-auto-deploy.sh [server address]
#
# Creates a "dm-me-deploy" user with a new SSH key that can do exactly one thing:
# run deploy/update.sh. It can't open a shell or run anything else. Then it prints the
# values to add as GitHub secrets. Running it again replaces the key (the old one stops
# working), so re-run it if the key ever leaks.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_USER=dm-me-deploy
UPDATE="$APP_DIR/deploy/update.sh"

die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33mWarning:\033[0m %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || die "Run this as root: sudo $0"
[[ -x $UPDATE ]] || die "$UPDATE is missing. Run this from the DM-me checkout on the server."
command -v sudo >/dev/null || die "sudo is required."
command -v ssh-keygen >/dev/null || die "ssh-keygen is required (apt install openssh-client)."

# ---- The deploy user and what it may run ---------------------------------------------

if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  # A real shell is needed for sshd to run the key's forced command; the key allows nothing else.
  useradd --system --create-home --shell /bin/sh "$DEPLOY_USER"
fi

sudoers=/etc/sudoers.d/dm-me-deploy
tmp_sudoers=$(mktemp)
# Exactly update.sh, with no arguments; GitHub names the commit to deploy in SSH_ORIGINAL_COMMAND.
sed "s|@UPDATE@|$UPDATE|g" "$APP_DIR/deploy/dm-me-deploy.sudoers" >"$tmp_sudoers"
visudo -cqf "$tmp_sudoers" || { rm -f "$tmp_sudoers"; die "sudo rejected the rule for $DEPLOY_USER."; }
install -m 440 -o root -g root "$tmp_sudoers" "$sudoers"
rm -f "$tmp_sudoers"

# ---- A fresh SSH key that can only run the update -------------------------------------

keydir=$(mktemp -d)
trap 'rm -rf "$keydir"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "github-actions-dm-me" -f "$keydir/key"

home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
printf 'restrict,command="sudo -n %s" %s\n' "$UPDATE" "$(cat "$keydir/key.pub")" >"$home/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"

# ---- What GitHub needs to reach this server -------------------------------------------

host=${1:-}
if [[ -z $host ]]; then
  host=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [[ -n $host ]] || host=$(hostname -I | awk '{print $1}')
fi
port=22
sshd_config=''
if command -v sshd >/dev/null; then
  sshd_config=$(sshd -T 2>/dev/null || true)
  port=$(awk '$1 == "port" { print $2; exit }' <<<"$sshd_config")
  port=${port:-22}
fi
hostspec=$host
[[ $port == 22 ]] || hostspec="[$host]:$port"
known_hosts=''
for pub in /etc/ssh/ssh_host_*_key.pub; do
  [[ -f $pub ]] && known_hosts+="$hostspec $(cut -d' ' -f1,2 "$pub")"$'\n'
done
[[ -n $known_hosts ]] || die "No SSH host keys in /etc/ssh. Is the SSH server installed?"

if grep -qiE '^(allowusers|allowgroups) ' <<<"$sshd_config"; then
  warn "Your SSH server only lets some users log in (AllowUsers or AllowGroups in /etc/ssh/sshd_config).
Add $DEPLOY_USER there and reload SSH (sudo systemctl reload ssh), or GitHub won't get in."
fi

port_secret=''
[[ $port == 22 ]] || port_secret=$'VPS_PORT\n'"$port"$'\n\n'

cat <<EOF

Done. In GitHub, open the DM-me repository > Settings > Secrets and variables > Actions,
and add these repository secrets (New repository secret, one per name):

VPS_HOST
$host

${port_secret}VPS_SSH_KEY   (everything from -----BEGIN to END-----, including those lines)
$(cat "$keydir/key")

VPS_KNOWN_HOSTS   (all lines)
${known_hosts%$'\n'}

The private key above isn't stored on this server; once it's in GitHub, clear your terminal.
From then on, every push to main is tested and deployed. Watch it under the repository's
Actions tab.
EOF
