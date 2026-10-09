import { serve } from '@hono/node-server';
import { createApp, pickResponder } from './app';
import { loadConfig } from './config';
import { openDb } from './db';

const config = loadConfig();
const db = openDb(config.dataDir);
const { responder, aiConnected } = pickResponder(config);
const { app } = createApp(db, config, responder);

if (!aiConnected) {
  console.warn('ANTHROPIC_API_KEY is not set: the app runs, but Nova will not reply until it is.');
} else if (config.fakeAi) {
  console.warn('DM_ME_FAKE_AI=1: Nova is using canned test replies instead of Claude.');
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`DM-me server listening on http://localhost:${info.port}`);
});
