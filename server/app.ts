import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { ClaudeResponder, FakeResponder, type Responder } from './ai/responder';
import { sameOrigin } from './auth';
import { ReplyService } from './chat';
import type { Config } from './config';
import type { DB } from './db';
import { MediaStore, MAX_UPLOAD_BYTES } from './media';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { mediaRoutes } from './routes/media';
import { storyRoutes } from './routes/stories';
import { ensureStories } from './stories';

export interface Deps {
  db: DB;
  config: Config;
  media: MediaStore;
  replies: ReplyService;
  aiConnected: boolean;
}

export function pickResponder(config: Config): { responder: Responder | null; aiConnected: boolean } {
  if (config.fakeAi) return { responder: new FakeResponder(), aiConnected: true };
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasKey) return { responder: null, aiConnected: false };
  return { responder: new ClaudeResponder(config.anthropicModel), aiConnected: true };
}

export function createApp(db: DB, config: Config, responder: Responder | null) {
  const media = new MediaStore(config.dataDir, config.assetsDir);
  const aiConnected = responder !== null;
  const replies = new ReplyService(db, media, responder ?? new FakeResponder());
  const deps: Deps = { db, config, media, replies, aiConnected };
  ensureStories(db, config.autoStories);

  const app = new Hono();
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
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
  app.use('/api/*', bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 512 * 1024, onError: (c) => c.json({ error: 'That upload is too large.' }, 413) }));

  app.route('/api/auth', authRoutes(deps));
  app.route('/api/chat', chatRoutes(deps));
  app.route('/api/stories', storyRoutes(deps));
  app.route('/api/media', mediaRoutes(deps));
  app.route('/api/admin', adminRoutes(deps));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong.' }, 500);
  });

  // In production the server also hands out the built web app.
  const indexFile = path.join(config.clientDir, 'index.html');
  if (fs.existsSync(indexFile)) {
    const root = path.relative(process.cwd(), config.clientDir);
    app.use('/assets/*', serveStatic({ root, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => c.html(fs.readFileSync(indexFile, 'utf8')));
  }

  return { app, deps };
}
