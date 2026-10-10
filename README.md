# DM-me

Instagram-style direct messages with **Nova**, an AI that texts back. It's a web app: one small Node server with a React front end. There are no accounts: each browser gets its own chat, remembered by a cookie.

What visitors can do:

- **Chat.** Send a few messages in a row and Nova answers them together, in short bubbles with a typing indicator, then shows "Seen". Double-tap one of Nova's messages to heart it; Nova sometimes hearts yours.
- **Send photos.** Take one with the camera or pick one from the library, then choose **View once**, **Allow replay** or **Keep in chat**. Nova looks at the photo and responds to what's in it. A view-once photo is shown to Nova once and then deleted.
- **Get photos from Nova.** Nova can send photos from her camera roll, sometimes as view-once or replay. Tap to view: the photo opens full screen for 5 seconds, then the bubble changes to "Tap to replay" or "Opened". The server enforces the limit.
- **Watch stories.** Nova's avatar gets the story ring when there's something new. Tap left or right to move, hold to pause, heart a story, or reply (the reply lands in the chat as "You replied to their story"). Stories expire after 24 hours.
- **Delete the chat** from Nova's profile sheet, which also deletes the photos they sent.

What you (the owner) can do at **`/admin`**, unlocked with `ADMIN_PASSWORD`:

- **Camera roll:** add the photos Nova can send. Each photo needs a description, because that's how Nova picks one; leave it empty and Nova writes it. You can also upload straight into the bucket's `library/` folder and press **Sync from bucket**.
- **Stories:** post photo or text stories and delete them.

## Run it locally

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env        # put your key in ANTHROPIC_API_KEY and pick an ADMIN_PASSWORD
npm run dev                 # web app on http://localhost:5173, API on :3001
```

Without a bucket configured, photos are kept in `data/media` on disk, which is fine for local use. Without an API key the app still runs, but Nova shows as offline. `DM_ME_FAKE_AI=1` gives canned test replies without calling Claude.

## Photo storage on a small VPS

Photos live in an S3-compatible bucket, so the VPS only keeps a small SQLite file (chat text, photo descriptions and story captions). Browsers load photos directly from the bucket through links that expire, so photo traffic doesn't go through the VPS either. The bucket stays private.

Any S3-compatible service works. **Cloudflare R2** is a good default: 10 GB free and no fees for downloads.

1. In the Cloudflare dashboard, open **R2**, create a bucket (for example `dm-me`) and leave it private.
2. Under **R2 → Manage API tokens**, create a token with **Object Read & Write** on that bucket. Copy the access key ID and secret.
3. Set in `.env`:

   ```
   S3_BUCKET=dm-me
   S3_ENDPOINT=https://<your account id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   ```

Backblaze B2, AWS S3, Supabase Storage (its S3 endpoint) and MinIO work the same way with their own endpoint and region. The bucket is organised as:

| Folder | What's in it |
|---|---|
| `library/` | Nova's camera roll. Files you add here directly appear after **Sync from bucket**. |
| `uploads/` | Photos visitors send. Deleted after Nova views a view-once photo, or when the chat is deleted. |
| `stories/` | Photos for stories posted from `/admin`. |

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required for Nova to reply. |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | The Claude model Nova uses. |
| `ADMIN_PASSWORD` | none | Unlocks `/admin`. Without it the admin page is off. |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | Photo storage bucket (above). `S3_PATH_STYLE=false` for providers that need `bucket.endpoint` URLs. |
| `PORT` | `3000` | Port for `npm start`. |
| `HOST` | `0.0.0.0` | Interface to listen on. `127.0.0.1` behind a reverse proxy. |
| `DATA_DIR` | `./data` | SQLite database, and photos when no bucket is set. |
| `DAILY_REPLY_LIMIT` | `200` | Nova replies per visitor per day, to cap API spend on a public site. |
| `AUTO_STORIES` | on | Re-post four sample stories whenever none are live. `off` to disable. |
| `SAMPLE_PHOTOS` | on | Start Nova's camera roll with four sample photos. `off` to start empty. |
| `PHOTO_SECONDS` | `5` | How long a view-once or replay photo stays on screen. |
| `SECRET` | generated | Signs cookies and photo links. Generated into `DATA_DIR/secret.key` if unset. |
| `DM_ME_FAKE_AI` | off | `1` replaces Claude with canned replies, for tests and demos. |

## Deploy

**On a VPS (recommended):** `deploy/setup.sh` installs everything on Debian or Ubuntu: the app as a service, HTTPS through Caddy, and continuous database backups to your bucket with Litestream. Follow [deploy/README.md](deploy/README.md).

**Anywhere else that runs Node 22:**

```bash
npm run build     # builds the web app into dist/client and the server into dist/server
npm start         # serves both on $PORT
```

Or with Docker:

```bash
docker build -t dm-me .
docker run -p 3000:3000 -v dm-me-data:/data --env-file .env dm-me
```

Wherever it runs:

- Put it behind **HTTPS**. Browsers only allow the camera on HTTPS, and cookies are marked secure when the request arrives over HTTPS, including behind a proxy that sets `X-Forwarded-Proto`. Set `HOST=127.0.0.1` so only the proxy can reach the app.
- Run **one server process**. Rate limits and the one-reply-at-a-time lock are kept in memory, and the database is a local SQLite file, so serverless hosts (Vercel, Cloudflare Workers) need changes first.
- **Back up the database** (`DATA_DIR/dm-me.sqlite`). The VPS setup does this for you.

## Checks

```bash
npm run typecheck
npm test                      # server and client unit tests

# Browser walkthrough with screenshots (uses Chromium via playwright-core):
DATA_DIR=/tmp/dmme-e2e DM_ME_FAKE_AI=1 ADMIN_PASSWORD=letmein PORT=3456 npm start &
node scripts/e2e.mjs http://localhost:3456 test-results/screens
```

## How it's built

```
server/            Hono API on Node, SQLite via better-sqlite3
  ai/nova.ts       Nova's persona, system prompt, sample photos and stories
  ai/context.ts    turns chat history into a Claude conversation (text, images, Nova's past replies)
  ai/responder.ts  the Claude calls (replies and photo descriptions), plus the fake used in tests
  chat.ts          reply flow: one reply per conversation at a time, view-once bookkeeping
  library.ts       Nova's camera roll: uploads, descriptions, bucket sync
  storage.ts       S3-compatible bucket client (signed requests and links) and local-disk storage
  media.ts         photo validation, signed links, small in-memory cache
  identity.ts      visitor cookie, admin password, rate limits
  routes/          chat, stories, media, admin
  assets/          sample photos
src/               React web app (Vite)
  pages/ChatPage   the conversation screen
  pages/AdminPage  camera roll and stories
  components/      message bubbles, camera, send-photo sheet, photo and story viewers
shared/types.ts    API shapes used by both sides
```

How Nova replies:

- Each reply is one call to **Claude Haiku 5.5** at `low` effort, which is fast and cheap for chat: $0.10 per million input tokens and $0.50 per million output, so a typical reply costs a small fraction of a cent. The answer comes back as structured JSON: the bubbles to send, whether to heart the visitor's last message, and optionally a camera-roll photo and how to send it.
- The conversation is sent each time, with each visitor message stamped in their time zone so Nova knows when "tonight" is. The persona prompt and earlier messages are prompt-cached.
- Kept photos are re-sent as images (up to the 12 most recent). A view-once photo is included only in the turn Nova first sees it; after that she gets a note saying she already viewed it.
- Nova is told about the newest 150 photos in her camera roll.
- If Claude declines a message for safety reasons, Nova answers "I can't help with that one." (Haiku has no automatic retry on another model.)

Privacy and safety:

- No accounts or passwords for visitors. The visitor cookie is random and stored only as a hash. Clearing cookies starts a fresh chat.
- Rate limits per visitor and per IP address, plus the daily reply cap.
- Uploads are checked by their actual bytes (JPEG, PNG, WebP, GIF only). Photos are only reachable through signed links that expire; view-once links last a minute.
- The browser re-encodes photos to JPEG at most 1568px on the long edge before upload, which also strips location metadata.
- A web page can't stop screenshots, so "view once" limits opening, not copying.

Sample photos in `server/assets` are from [Unsplash](https://unsplash.com) under the Unsplash License: photo IDs `1510693206972-df098062cb71`, `1495474472287-4d71bcdd2085`, `1504674900247-0877df9cc836` and `1469474968028-56623f02e42e`.
