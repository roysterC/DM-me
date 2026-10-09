import { Hono } from 'hono';
import type { ChatDTO, OpenPhotoDTO, PhotoMode } from '../../shared/types';
import { NOVA } from '../ai/nova';
import { AiUnavailableError } from '../ai/responder';
import type { AppEnv } from '../auth';
import { RateLimiter, requireUser } from '../auth';
import { conversationFor, getMessage, listMessages, maxViews, toMessageDTO } from '../chat';
import type { MessageRow } from '../db';
import { nowIso } from '../db';
import { MediaError } from '../media';
import { activeStoryMap } from '../stories';
import type { Deps } from '../app';

const MAX_TEXT = 2000;
const MODES: PhotoMode[] = ['keep', 'once', 'replay'];

export function chatRoutes({ db, config, media, replies, aiConnected }: Deps) {
  const app = new Hono<AppEnv>();
  const sends = new RateLimiter(60, 60_000);
  const replyLimit = new RateLimiter(20, 60_000);
  app.use('*', requireUser(db));

  const chatState = (conversationId: number): ChatDTO => {
    const stories = activeStoryMap(db);
    return {
      persona: NOVA,
      messages: listMessages(db, conversationId).map((r) => toMessageDTO(r, stories)),
      aiConnected,
    };
  };

  const messageDTO = (row: MessageRow) => toMessageDTO(row, activeStoryMap(db));

  app.get('/', (c) => c.json(chatState(conversationFor(db, c.get('user').id))));

  app.post('/messages', async (c) => {
    const user = c.get('user');
    const body = await c.req.json<{ text?: string }>().catch(() => ({}) as never);
    const text = String(body.text ?? '').trim();
    if (!text) return c.json({ error: 'Message is empty.' }, 400);
    if (text.length > MAX_TEXT) return c.json({ error: `Messages can be up to ${MAX_TEXT} characters.` }, 400);
    if (!sends.take(`u${user.id}`)) return c.json({ error: 'You’re sending messages too fast.' }, 429);
    const conversationId = conversationFor(db, user.id);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO messages (conversation_id, sender, kind, text, created_at) VALUES (?, 'user', 'text', ?, ?)",
      )
      .run(conversationId, text, nowIso());
    return c.json({ message: messageDTO(getMessage(db, conversationId, Number(lastInsertRowid))!) });
  });

  app.post('/photos', async (c) => {
    const user = c.get('user');
    if (!sends.take(`u${user.id}`)) return c.json({ error: 'You’re sending messages too fast.' }, 429);
    const form = await c.req.parseBody();
    const file = form.photo;
    if (!(file instanceof File)) return c.json({ error: 'No photo attached.' }, 400);
    const mode = (MODES as string[]).includes(String(form.mode)) ? (String(form.mode) as PhotoMode) : 'keep';
    const dim = (v: unknown) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n > 0 && n <= 20_000 ? n : null;
    };
    let saved;
    try {
      saved = await media.saveUpload(file);
    } catch (err) {
      if (err instanceof MediaError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const conversationId = conversationFor(db, user.id);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender, kind, media_file, media_mime, media_width, media_height, photo_mode, created_at)
         VALUES (?, 'user', 'photo', ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, saved.name, saved.mime, dim(form.width), dim(form.height), mode, nowIso());
    return c.json({ message: messageDTO(getMessage(db, conversationId, Number(lastInsertRowid))!) });
  });

  app.post('/reply', async (c) => {
    const user = c.get('user');
    const body = await c.req.json<{ timeZone?: string }>().catch(() => ({}) as never);
    const timeZone = typeof body.timeZone === 'string' && body.timeZone.length < 64 ? body.timeZone : 'UTC';
    const conversationId = conversationFor(db, user.id);
    if (!aiConnected) {
      return c.json({ error: 'Nova isn’t connected yet. Set ANTHROPIC_API_KEY on the server.' }, 503);
    }
    if (!replyLimit.take(`u${user.id}`)) return c.json({ error: 'Slow down a little, Nova is catching up.' }, 429);
    try {
      await replies.replyTo(user, conversationId, timeZone);
    } catch (err) {
      if (err instanceof AiUnavailableError) return c.json({ error: err.message }, 503);
      console.error('Nova reply failed', err);
      return c.json({ error: 'Nova couldn’t reply. Try again.' }, 502);
    }
    return c.json(chatState(conversationId));
  });

  app.post('/messages/:id/heart', async (c) => {
    const user = c.get('user');
    const body = await c.req.json<{ on?: boolean }>().catch(() => ({}) as never);
    const conversationId = conversationFor(db, user.id);
    const row = getMessage(db, conversationId, Number(c.req.param('id')));
    if (!row || row.sender !== 'ai') return c.json({ error: 'Message not found.' }, 404);
    db.prepare('UPDATE messages SET heart_by_user = ? WHERE id = ?').run(body.on ? 1 : 0, row.id);
    return c.json({ message: messageDTO(getMessage(db, conversationId, row.id)!) });
  });

  // Opening a view-once or replay photo Nova sent. Each open uses up one view.
  app.post('/messages/:id/open', (c) => {
    const user = c.get('user');
    const conversationId = conversationFor(db, user.id);
    const row = getMessage(db, conversationId, Number(c.req.param('id')));
    if (!row || row.sender !== 'ai' || row.kind !== 'photo' || !row.media_file) {
      return c.json({ error: 'Photo not found.' }, 404);
    }
    const limit = maxViews(row.photo_mode);
    if (limit == null) return c.json({ error: 'This photo stays in the chat; open it directly.' }, 400);
    const consumed = db
      .prepare('UPDATE messages SET view_count = view_count + 1 WHERE id = ? AND view_count < ?')
      .run(row.id, limit);
    if (consumed.changes === 0) return c.json({ error: 'This photo can’t be opened again.' }, 410);
    const token = media.issueToken(row.media_file, row.media_mime ?? 'image/jpeg');
    const out: OpenPhotoDTO = {
      url: `/api/media/t/${token}`,
      seconds: config.photoSeconds,
      viewCount: row.view_count + 1,
      maxViews: limit,
    };
    return c.json(out);
  });

  return app;
}
