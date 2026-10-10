import { serve } from '@hono/node-server';
import { createApp, pickResponder } from './app';
import { loadConfig } from './config';
import { openDb } from './db';

const config = loadConfig();
const db = openDb(config.dataDir);
const responder = pickResponder(config);
const { app, deps } = createApp(db, config, responder);

if (!responder) console.warn('ANTHROPIC_API_KEY is not set: the app runs, but Nova will not reply until it is.');
else if (config.fakeAi) console.warn('DM_ME_FAKE_AI=1: Nova is using canned test replies instead of Claude.');
else console.log(`Nova replies with ${config.anthropicModel}.`);
console.log(
  deps.media.storage.kind === 's3'
    ? `Photos are stored in the bucket "${config.s3!.bucket}".`
    : 'Photos are stored on this server (set S3_BUCKET to use object storage).',
);
if (!config.adminPassword) console.log('Admin page disabled: set ADMIN_PASSWORD to manage stories and photos.');

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`DM-me server listening on http://${config.host}:${info.port}`);
});
