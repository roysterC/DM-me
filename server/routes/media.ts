import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../auth';
import { requireUser } from '../auth';
import { conversationFor, getMessage } from '../chat';
import { activeStoryMap } from '../stories';
import type { Deps } from '../app';

export function mediaRoutes({ db, media }: Deps) {
  const app = new Hono<AppEnv>();

  const send = (c: Context, ref: string, mime: string, cache: string) => {
    const data = media.read(ref);
    if (!data) return c.json({ error: 'File not found.' }, 404);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': mime,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
  };

  // Single-use links for view-once and replay photos. Deliberately not cached.
  app.get('/t/:token', requireUser(db), (c) => {
    const entry = media.redeemToken(c.req.param('token'));
    if (!entry) return c.json({ error: 'This link has expired.' }, 410);
    return send(c, entry.file, entry.mime, 'no-store');
  });

  // Photos kept in the chat, for the conversation's owner only.
  app.get('/message/:id', requireUser(db), (c) => {
    const conversationId = conversationFor(db, c.get('user').id);
    const row = getMessage(db, conversationId, Number(c.req.param('id')));
    if (!row || row.kind !== 'photo' || row.photo_mode !== 'keep' || !row.media_file) {
      return c.json({ error: 'Photo not found.' }, 404);
    }
    return send(c, row.media_file, row.media_mime ?? 'image/jpeg', 'private, max-age=86400');
  });

  app.get('/story/:id', requireUser(db), (c) => {
    const story = activeStoryMap(db).get(Number(c.req.param('id')));
    if (!story || !story.media_file) return c.json({ error: 'Story not found.' }, 404);
    return send(c, story.media_file, story.media_mime ?? 'image/jpeg', 'private, max-age=3600');
  });

  return app;
}
