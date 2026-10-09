# DM-me

Instagram-style direct messages with **Nova**, an AI that texts back. It is a web app: one Node server with a React front end and a SQLite database.

What you can do:

- **Chat.** Send a few messages in a row and Nova answers them together, in short bubbles with a typing indicator, then shows "Seen". Double-tap one of Nova's messages to heart it; Nova sometimes hearts yours.
- **Photos.** Take one with the camera or pick one from your library, then choose **View once**, **Allow replay** or **Keep in chat**. Nova (Claude) looks at the photo and responds to what's in it. A view-once photo is shown to Nova once and then deleted from the server.
- **Nova's photos.** Nova can send photos back, sometimes as view-once or replay. Tap to view: the photo opens full screen for 5 seconds, then the bubble changes to "Tap to replay" or "Opened". The server enforces the limit.
- **Stories.** Nova's avatar gets the story ring when there's something new. Tap it to watch: one progress bar per story, tap left or right to move, hold to pause, heart a story, or reply (the reply lands in the chat as "You replied to their story"). The ring turns grey once you've seen everything. Stories expire after 24 hours.
- **Admin.** Accounts listed in `ADMIN_USERNAMES` get a "Manage stories" page to post photo or text stories and delete them.
- Dark and light mode follow the device. Sign up with a username and password.

## Run it locally

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
npm run dev                 # web app on http://localhost:5173, API on :3001
```

Without an API key the app still runs, but Nova shows as offline and won't reply. For trying the interface without spending API credit, set `DM_ME_FAKE_AI=1` to get canned test replies.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required for Nova to reply. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | The Claude model Nova uses. |
| `PORT` | `3000` | Port for `npm start`. |
| `DATA_DIR` | `./data` | Where the SQLite database and uploaded photos live. Must be on a persistent disk in production. |
| `ADMIN_USERNAMES` | none | Comma-separated usernames that can manage Nova's stories at `/admin`. |
| `AUTO_STORIES` | on | Nova re-posts four sample stories whenever none are live. Set to `off` to disable. |
| `PHOTO_SECONDS` | `5` | How long a view-once or replay photo stays on screen. |
| `DM_ME_FAKE_AI` | off | `1` replaces Claude with canned replies, for tests and demos. |

## Deploy

```bash
npm run build     # builds the web app into dist/client and the server into dist/server
npm start         # serves both on $PORT
```

Or with Docker:

```bash
docker build -t dm-me .
docker run -p 3000:3000 -v dm-me-data:/data -e ANTHROPIC_API_KEY=... dm-me
```

Hosting notes:

- Use a host with a **persistent disk** for `DATA_DIR` (a VPS, Fly.io volume, Railway volume or Render disk). Serverless platforms without a disk won't keep the database or photos.
- Put it behind **HTTPS**. Login cookies are marked secure when the request arrives over HTTPS, including behind a proxy that sets `X-Forwarded-Proto`.
- Run **one server process**. Rate limits, the one-reply-at-a-time lock and photo links are kept in memory.

## Checks

```bash
npm run typecheck
npm test                      # server and client unit tests

# Browser walkthrough with screenshots (uses Chromium via playwright-core):
DATA_DIR=/tmp/dmme-e2e DM_ME_FAKE_AI=1 ADMIN_USERNAMES=maya PORT=3456 npm start &
node scripts/e2e.mjs http://localhost:3456 test-results/screens
```

## How it's built

```
server/            Hono API on Node, SQLite via better-sqlite3
  ai/nova.ts       Nova's persona, system prompt, camera roll and sample stories
  ai/context.ts    turns chat history into a Claude conversation (text, images, Nova's past replies)
  ai/responder.ts  the Claude call, plus the fake responder used in tests
  chat.ts          reply flow: one reply per conversation at a time, view-once bookkeeping
  routes/          auth, chat, stories, media, admin
  assets/          sample photos (Nova's camera roll and default stories)
src/               React web app (Vite)
  pages/ChatPage   the conversation screen
  components/      message bubbles, camera, send-photo sheet, photo and story viewers
shared/types.ts    API shapes used by both sides
```

How Nova replies:

- Each reply is one call to the Claude Messages API at `low` effort, which keeps chat fast. The answer comes back as structured JSON: the bubbles to send, whether to heart the user's last message, and an optional photo from her camera roll with its mode.
- The whole conversation is sent each time. Each user message starts with a timestamp in the user's time zone, so Nova knows when "tonight" is. The persona prompt and earlier messages are prompt-cached, so long chats stay cheap.
- Kept photos are re-sent as images (up to the 12 most recent). A view-once photo is included only in the turn Nova first sees it; after that she gets a note saying she already viewed it.
- Server-side refusal fallbacks are turned on (`fallbacks: "default"`), so a falsely flagged message is retried on another model instead of failing.

Privacy and safety:

- Passwords are hashed with scrypt; sessions are random tokens stored as hashes. Login and sign-up are rate limited.
- Uploads are checked by their actual bytes (JPEG, PNG, WebP, GIF only) and stored privately. Kept photos are only served to their owner. View-once photos are fetched through single-use links that expire after a minute.
- The browser re-encodes photos to JPEG at most 1568px on the long edge before upload, which also strips location metadata.
- A web page can't stop screenshots, so "view once" limits opening, not copying.

Sample photos in `server/assets` are from [Unsplash](https://unsplash.com) under the Unsplash License: photo IDs `1510693206972-df098062cb71`, `1495474472287-4d71bcdd2085`, `1504674900247-0877df9cc836` and `1469474968028-56623f02e42e`.
