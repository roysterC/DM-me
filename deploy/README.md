# Deploying DM-me on a VPS

`deploy/setup.sh` turns a fresh Debian or Ubuntu server into a running DM-me site:

- **Node.js 22** runs the app as a systemd service that starts on boot and restarts if it crashes.
- **Caddy** serves it over HTTPS and renews the certificate automatically.
- **Litestream** copies every change to the database into your bucket within about a second, so a dead server loses almost nothing.

The app itself only listens on `127.0.0.1:3000` (or the next free port if another program already uses 3000); the outside world reaches it through Caddy.

## What you need

- A VPS running **Ubuntu 22.04 or 24.04, or Debian 12**, with root (sudo) access. 1 GB of memory is comfortable; with less, add swap (below).
- A **domain or subdomain** for the site, e.g. `chat.yourdomain.com`. The browser camera only works over HTTPS, and HTTPS needs a domain. **No domain?** Use a free nip.io address instead (see below).
- A **Cloudflare R2 bucket** with an API token (see "Photo storage" in the main README). It holds the photos *and* the database backups.
- Your **Anthropic API key**, and an **admin password** you choose.

## Already running Caddy for another site?

Setup reuses it: it doesn't install a second Caddy or restart yours.

- **What it finds:** the running Caddy, wherever it's installed, and the Caddyfile it was started with.
- **What it changes:** it saves a copy of your Caddyfile as `<your Caddyfile>.before-dm-me`, adds one line at the end (`import /etc/caddy/sites/*.caddy`), and puts the DM-me site in `/etc/caddy/sites/dm-me.caddy`. Your other site's config is untouched.
- **How it applies it:** with a graceful reload, so your other site keeps serving. If Caddy rejects the result, setup removes the DM-me site, restores your original Caddyfile and stops.

Setup prints the few lines to add yourself instead when it can't safely change Caddy:
- Caddy runs inside Docker.
- Caddy uses a JSON or API-managed config.
- Another web server, such as nginx or Apache, holds ports 80 and 443.

After adding them, set `CADDY=off` in `/etc/dm-me/dm-me.env` and run setup again.

## No domain? Use nip.io

[nip.io](https://nip.io) is a free service where the name contains the IP address: `203-0-113-10.nip.io` always points to `203.0.113.10`. There's nothing to register: set `DOMAIN` to your server's IP with dashes plus `.nip.io`, and skip step 1 below. If you leave `DOMAIN` unset, setup prints the right value for your server. Caddy gets a real HTTPS certificate for it, so the camera works.

Trade-offs to know:

- **It depends on nip.io's servers.** If they're down, nobody can find your site, even though your server is fine.
- **Certificates are shared.** Let's Encrypt allows a large but shared number of nip.io certificates per week. If Caddy's log mentions a rate limit, change `nip.io` to `sslip.io` in `DOMAIN` (the same service under another name) and run setup again.
- **The address changes if the IP changes**, for example if you rebuild the VPS or later buy a domain. A new address is a new site to the browser: visitors start new chats (their old ones are still in the database, just not reachable from the new address), and you log in to `/admin` again.
- **It looks temporary** to visitors. A real domain costs about $10 a year (Cloudflare Registrar sells them at cost), and switching is just changing `DOMAIN` and running setup again.

## First install

**1. Point the domain at the server** (skip this with nip.io). Add an `A` record for your domain with the VPS's IP address. If the domain is on Cloudflare, set the record to **DNS only** (grey cloud) at least until the first certificate is issued.

**2. Open ports 80 and 443** in your VPS provider's firewall. If you use `ufw` on the server:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

**3. Get the code onto the server** into `/opt/dm-me`:

```bash
sudo git clone https://github.com/roysterC/DM-me.git /opt/dm-me
```

If the repository is private, git asks for credentials. Use your GitHub username and a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with read-only **Contents** access to this one repository. To avoid typing it on every update, run `sudo git config --global credential.helper store` first (it saves the token in `/root/.git-credentials`).

**4. Run setup once to create the settings file**, then fill it in:

```bash
sudo /opt/dm-me/deploy/setup.sh
sudo nano /etc/dm-me/dm-me.env
```

Set `DOMAIN`, `ANTHROPIC_API_KEY`, `ADMIN_PASSWORD` and the five `S3_` values. `SECRET` is already generated; leave it.

**5. Run setup again** to install and start everything:

```bash
sudo /opt/dm-me/deploy/setup.sh
```

It takes a few minutes the first time. When it finishes, open `https://your-domain`. The first visit can take a few seconds while Caddy gets the certificate. Manage Nova at `https://your-domain/admin`.

## Updating

After you merge changes on GitHub:

```bash
sudo /opt/dm-me/deploy/update.sh
```

This pulls the code, rebuilds, and restarts the app. The site is unavailable for a few seconds during the restart. If the new version fails to start, the script prints the two commands that put the previous version back.

## Day to day

| Task | Command |
|---|---|
| Watch the app's log | `journalctl -u dm-me -f` |
| Watch the backup log | `journalctl -u dm-me-backup -f` |
| Restart after editing `/etc/dm-me/dm-me.env` | `sudo systemctl restart dm-me dm-me-backup` |
| Check everything is running | `systemctl status dm-me dm-me-backup caddy` |

## Backups and restoring

The database (chats, visitor sessions, photo descriptions, stories) is a single SQLite file, `/var/lib/dm-me/dm-me.sqlite`. Litestream streams it to `backups/dm-me/` in your bucket. The photos are already in the bucket.

**Moving to a new server, or after losing one:** copy `/etc/dm-me/dm-me.env` from the old server (or recreate it with the **same** bucket and `SECRET`), then follow the first-install steps. Setup finds the backup and restores it before starting the app. Keep a copy of that env file somewhere safe, such as a password manager, because it isn't in the bucket.

**Rolling back to an earlier moment** (for example after a mistake on the admin page):

```bash
sudo systemctl stop dm-me dm-me-backup
sudo mv /var/lib/dm-me/dm-me.sqlite /var/lib/dm-me/dm-me.sqlite.bad
sudo rm -rf /var/lib/dm-me/dm-me.sqlite-wal /var/lib/dm-me/dm-me.sqlite-shm /var/lib/dm-me/.dm-me.sqlite-litestream
sudo systemd-run --wait --pipe -p User=dmme -p EnvironmentFile=/etc/dm-me/dm-me.env \
  litestream restore -config /etc/dm-me/litestream.yml -timestamp 2026-10-10T09:00:00Z /var/lib/dm-me/dm-me.sqlite
sudo systemctl start dm-me dm-me-backup
```

Litestream keeps short-term history and compacts it over time, so recent points restore most precisely.

## Troubleshooting

- **The site doesn't load over HTTPS.** Check that the domain resolves to this server (`dig +short your-domain`) and that ports 80 and 443 are open. Caddy's log explains certificate problems: `journalctl -u caddy -n 50`.
- **Setup says something else is using port 80 or 443.** Another web server (often nginx or Apache) is installed. Either stop and disable it, or keep it: add the site setup printed (proxy your domain to `127.0.0.1:3000`), set `CADDY=off` in `/etc/dm-me/dm-me.env`, and run setup again.
- **The build gets killed on a small server.** Add swap, then run setup again:

  ```bash
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

- **"Failed to query local AF_VSOCK CID".** A harmless warning systemd prints on many virtual servers. Ignore it.
- **Port 3000 is already in use** (another site's app, say). Setup detects this, uses the next free port and saves it as `PORT` in `/etc/dm-me/dm-me.env`. If you set `PORT` yourself, it must be free.
- **Nova doesn't reply.** Check `ANTHROPIC_API_KEY` in `/etc/dm-me/dm-me.env`, restart, and look at `journalctl -u dm-me -n 50`.
- **Backups aren't appearing in the bucket.** Look at `journalctl -u dm-me-backup -n 50`. The R2 token needs **Object Read & Write** on the bucket.

## What setup puts where

| Path | What it is |
|---|---|
| `/opt/dm-me` | The code and the built app (owned by root; the app can't modify it) |
| `/etc/dm-me/dm-me.env` | Your settings and keys (readable by root only) |
| `/etc/dm-me/litestream.yml` | Backup settings |
| `/var/lib/dm-me` | The database (the only folder the app can write to) |
| `/etc/systemd/system/dm-me.service`, `dm-me-backup.service` | The app and backup services, running as the `dmme` user |
| `/etc/caddy/sites/dm-me.caddy` | The HTTPS site, imported by one line at the end of your Caddyfile. Your own Caddy sites are left alone |
