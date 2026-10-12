import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { ClaudeResponder, FakeResponder, type Responder } from './ai/responder';
import { Budget } from './budget';
import { ReplyService } from './chat';
import type { Config } from './config';
import type { DB } from './db';
import { type AppEnv, sameOrigin, visitor } from './identity';
import { seedLibrary } from './library';
import { PHOTOS_PER_UPLOAD } from '../shared/types';
import { MAX_UPLOAD_BYTES, MAX_VISITOR_PHOTO_BYTES, MediaStore } from './media';
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
  budget: Budget;
}

export function pickResponder(config: Config, budget: Budget): Responder | null {
  if (config.fakeAi) return new FakeResponder();
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return hasKey ? new ClaudeResponder(config.anthropicModel, budget) : null;
}

const KB = 1024;
/** Room for a photo's form fields and multipart framing. */
const FORM_OVERHEAD = 64 * KB;
/**
 * Request bodies are read into memory whole, so each route accepts only what it needs: photo
 * uploads get room for their photos, and everything else (small JSON) gets JSON_BODY_BYTES.
 */
const JSON_BODY_BYTES = 64 * KB;
const UPLOAD_BODY_BYTES: Record<string, number> = {
  '/api/chat/photos': MAX_VISITOR_PHOTO_BYTES + FORM_OVERHEAD,
  '/api/admin/stories': MAX_UPLOAD_BYTES + FORM_OVERHEAD,
  '/api/admin/photos': PHOTOS_PER_UPLOAD * MAX_UPLOAD_BYTES + FORM_OVERHEAD,
};

export function pickStorage(config: Config): Storage {
  if (config.s3) return new S3Storage(config.s3);
  return new LocalStorage(config.dataDir === ':memory:' ? fs.mkdtempSync('/tmp/dmme-media-') : path.join(config.dataDir, 'media'));
}

export function createApp(db: DB, config: Config, responder: Responder | null, storage: Storage = pickStorage(config)) {
  const media = new MediaStore(storage, config.assetsDir, config.secret);
  const replies = new ReplyService(db, media, responder ?? new FakeResponder(), config.typingCharsPerSecond);
  const budget = new Budget(db, config.dailyBudgetUsd);
  const deps: Deps = { db, config, media, replies, responder, aiConnected: responder !== null, budget };
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
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      permissionsPolicy: { camera: ['self'], microphone: [] },
    }),
  );
  app.use('/api/*', sameOrigin());
  const jsonLimit = bodyLimit({
    maxSize: JSON_BODY_BYTES,
    onError: (c) => c.json({ error: 'That’s too much to send at once.' }, 413),
  });
  const uploadLimits = new Map(
    Object.entries(UPLOAD_BODY_BYTES).map(([route, maxSize]) => [
      route,
      bodyLimit({ maxSize, onError: (c) => c.json({ error: 'That photo is too large.' }, 413) }),
    ]),
  );
  app.use('/api/*', (c, next) => ((c.req.method === 'POST' && uploadLimits.get(c.req.path)) || jsonLimit)(c, next));

  const visitorApi = new Hono<AppEnv>();
  visitorApi.use('*', visitor(db));
  visitorApi.route('/chat', chatRoutes(deps));
  visitorApi.route('/stories', storyRoutes(deps));

  // Lets deploys confirm it's DM-me answering on the port, and that it can really serve: the
  // database answers and, in production, the built web app is there. A 503 makes the deploy
  // roll back to the previous version.
  const indexFile = path.join(config.clientDir, 'index.html');
  app.get('/api/health', (c) => {
    const problems: string[] = [];
    try {
      db.prepare('SELECT 1').get();
    } catch {
      problems.push('database');
    }
    if (process.env.NODE_ENV === 'production' && !fs.existsSync(indexFile)) problems.push('web app files');
    return problems.length
      ? c.json({ app: 'dm-me', ok: false, problems }, 503)
      : c.json({ app: 'dm-me', ok: true });
  });
  app.route('/api/media', mediaRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.route('/api', visitorApi);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong.' }, 500);
  });

  // In production the server also hands out the built web app.
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
