import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { ClaudeResponder, FakeResponder, type Responder } from './ai/responder';
import { ReplyService } from './chat';
import type { Config } from './config';
import type { DB } from './db';
import { type AppEnv, sameOrigin, visitor } from './identity';
import { seedLibrary } from './library';
import { MAX_UPLOAD_BYTES, MediaStore } from './media';
import { adminRoutes } from './routes/admin';
import { chatRoutes } from './routes/chat';
import { mediaRoutes } from './routes/media';
import { storyRoutes } from './routes/stories';
import { LocalStorage, S3Storage, type Storage } from './storage';
import { ensureStories } from './stories';

export interface Deps {
  db: DB;
  config: Config;
  media: MediaStore;
  replies: ReplyService;
  /** Null when Claude isn't configured; the camera roll then describes photos by file name. */
  responder: Responder | null;
  aiConnected: boolean;
}

export function pickResponder(config: Config): Responder | null {
  if (config.fakeAi) return new FakeResponder();
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return hasKey ? new ClaudeResponder(config.anthropicModel) : null;
}

export function pickStorage(config: Config): Storage {
  if (config.s3) return new S3Storage(config.s3);
  return new LocalStorage(config.dataDir === ':memory:' ? fs.mkdtempSync('/tmp/dmme-media-') : path.join(config.dataDir, 'media'));
}

export function createApp(db: DB, config: Config, responder: Responder | null, storage: Storage = pickStorage(config)) {
  const media = new MediaStore(storage, config.assetsDir, config.secret);
  const replies = new ReplyService(db, media, responder ?? new FakeResponder());
  const deps: Deps = { db, config, media, replies, responder, aiConnected: responder !== null };
  seedLibrary(db, config.seedSamplePhotos);
  ensureStories(db, config.autoStories);

  const s3Origin = config.s3 ? new URL(config.s3.endpoint).origin : null;
  const s3Hosts = config.s3
    ? [s3Origin!, `${new URL(config.s3.endpoint).protocol}//${config.s3.bucket}.${new URL(config.s3.endpoint).host}`]
    : [];

  const app = new Hono();
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:', ...s3Hosts],
        mediaSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      permissionsPolicy: { camera: ['self'], microphone: [] },
    }),
  );
  app.use('/api/*', sameOrigin());
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 20 * MAX_UPLOAD_BYTES,
      onError: (c) => c.json({ error: 'That upload is too large.' }, 413),
    }),
  );

  const visitorApi = new Hono<AppEnv>();
  visitorApi.use('*', visitor(db));
  visitorApi.route('/chat', chatRoutes(deps));
  visitorApi.route('/stories', storyRoutes(deps));

  // Lets deploy scripts confirm it's DM-me answering on the port, not some other program.
  app.get('/api/health', (c) => c.json({ app: 'dm-me', ok: true }));
  app.route('/api/media', mediaRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.route('/api', visitorApi);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong.' }, 500);
  });

  // In production the server also hands out the built web app.
  const indexFile = path.join(config.clientDir, 'index.html');
  if (fs.existsSync(indexFile)) {
    const root = path.relative(process.cwd(), config.clientDir);
    app.use(
      '/assets/*',
      serveStatic({ root, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }),
    );
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => c.html(fs.readFileSync(indexFile, 'utf8')));
  }

  return { app, deps };
}
