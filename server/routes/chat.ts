import { Hono } from 'hono';
import type { ChatDTO, OpenPhotoDTO, PhotoMode } from '../../shared/types';
import { PERSONA } from '../ai/persona';
import { AiUnavailableError, DONE_FOR_TODAY } from '../ai/responder';
import type { Deps } from '../app';
import { conversationFor, getMessage, listMessages, maxViews, ownedUploads, splitDue, toMessageDTO } from '../chat';
import type { MessageRow } from '../db';
import { nowIso } from '../db';
import { type AppEnv, clientHost, clientIp, isHttps, RateLimiter, SENDING_TOO_FAST } from '../identity';
import { MAX_VISITOR_PHOTO_BYTES, MediaError } from '../media';
import { activeStoryMap } from '../stories';

export const MAX_TEXT = 2000;
const MODES: PhotoMode[] = ['keep', 'once', 'replay'];

export function chatRoutes({ db, config, media, replies, aiConnected, budget, sends, push }: Deps) {
  const app = new Hono<AppEnv>();
  const repliesPerVisitor = new RateLimiter(20, 60_000);
  const repliesPerIp = new RateLimiter(40, 60_000);

  const chatState = async (conversationId: number): Promise<ChatDTO> => {
    const stories = activeStoryMap(db);
    const { shown, upcoming } = splitDue(listMessages(db, conversationId));
    const byId = new Map(shown.map((r) => [r.id, r]));
    const lookup = (id: number) => byId.get(id) ?? getMessage(db, conversationId, id);
    return {
      persona: PERSONA,
      messages: await Promise.all(shown.map((r) => toMessageDTO(r, stories, media, lookup))),
      upcoming,
      aiConnected,
    };
  };
  const messageDTO = (row: MessageRow) =>
    toMessageDTO(row, activeStoryMap(db), media, (id) => getMessage(db, row.conversation_id, id));
  /** A message in this chat, already showing, that a new message may quote; anything else is ignored. */
  const replyTarget = (conversationId: number, raw: unknown): number | null => {
    const id = Number(raw);
    if (!raw || !Number.isInteger(id)) return null;
    const row = getMessage(db, conversationId, id);
    return row && row.created_at <= nowIso() ? row.id : null;
  };

  app.get('/', async (c) => {
    push.sawChat(c.get('visitor').id);
    return c.json(await chatState(conversationFor(db, c.get('visitor').id)));
  });

  app.post('/messages', async (c) => {
    const visitor = c.get('visitor');
    const body = await c.req.json<{ text?: string; replyTo?: number }>().catch(() => ({}) as never);
    const text = String(body.text ?? '').trim();
    if (!text) return c.json({ error: 'Message is empty.' }, 400);
    if (text.length > MAX_TEXT) return c.json({ error: `Messages can be up to ${MAX_TEXT} characters.` }, 400);
    if (!sends.take(c, visitor.id)) return c.json({ error: SENDING_TOO_FAST }, 429);
    const conversationId = conversationFor(db, visitor.id);
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO messages (conversation_id, sender, kind, text, reply_to_id, created_at) VALUES (?, 'user', 'text', ?, ?, ?)",
      )
      .run(conversationId, text, replyTarget(conversationId, body.replyTo), nowIso());
    return c.json({ message: await messageDTO(getMessage(db, conversationId, Number(lastInsertRowid))!) });
  });

  app.post('/photos', async (c) => {
    const visitor = c.get('visitor');
    if (!sends.take(c, visitor.id)) return c.json({ error: SENDING_TOO_FAST }, 429);
    const form = await c.req.parseBody();
    if (!(form.photo instanceof File)) return c.json({ error: 'No photo attached.' }, 400);
    const mode = (MODES as string[]).includes(String(form.mode)) ? (String(form.mode) as PhotoMode) : 'keep';
    let saved;
    try {
      saved = await media.saveFile('uploads', form.photo, MAX_VISITOR_PHOTO_BYTES);
    } catch (err) {
      if (err instanceof MediaError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const conversationId = conversationFor(db, visitor.id);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender, kind, media_key, media_mime, media_width, media_height, photo_mode, reply_to_id, created_at)
         VALUES (?, 'user', 'photo', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, saved.key, saved.mime, saved.width, saved.height, mode, replyTarget(conversationId, form.replyTo), nowIso());
    return c.json({ message: await messageDTO(getMessage(db, conversationId, Number(lastInsertRowid))!) });
  });

  app.post('/reply', async (c) => {
    const visitor = c.get('visitor');
    const body = await c.req.json<{ timeZone?: string }>().catch(() => ({}) as never);
    const timeZone = typeof body.timeZone === 'string' && body.timeZone.length < 64 ? body.timeZone : 'UTC';
    const conversationId = conversationFor(db, visitor.id);
    if (!aiConnected) {
      return c.json({ error: 'Alisa isn’t connected yet. Set ANTHROPIC_API_KEY on the server.' }, 503);
    }
    if (!repliesPerVisitor.take(`v${visitor.id}`) || !repliesPerIp.take(clientIp(c))) {
      return c.json({ error: 'Slow down a little, Alisa is catching up.' }, 429);
    }
    const day = nowIso().slice(0, 10);
    const used = db.prepare('SELECT count FROM reply_counts WHERE visitor_id = ? AND day = ?').get(visitor.id, day) as
      | { count: number }
      | undefined;
    // Each visitor's own cap, then the whole site's Claude spend for the day.
    if ((used?.count ?? 0) >= config.dailyReplyLimit || budget.exhausted()) {
      return c.json({ error: DONE_FOR_TODAY }, 429);
    }
    try {
      const lastBefore = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?').get(conversationId) as {
        id: number;
      }).id;
      const replied = await replies.replyTo(conversationId, timeZone);
      if (replied) {
        // If they close the chat while she's "typing", their devices hear about it.
        push.afterReply(visitor.id, conversationId, lastBefore, PERSONA.name);
        db.prepare(
          `INSERT INTO reply_counts (visitor_id, day, count) VALUES (?, ?, 1)
           ON CONFLICT (visitor_id, day) DO UPDATE SET count = count + 1`,
        ).run(visitor.id, day);
      }
    } catch (err) {
      if (err instanceof AiUnavailableError) return c.json({ error: err.message }, 503);
      console.error('Alisa reply failed', err);
      return c.json({ error: 'Alisa couldn’t reply. Try again.' }, 502);
    }
    // The bubbles due already go back with this answer (all of them, with replies shown instantly).
    push.sawChat(visitor.id);
    return c.json(await chatState(conversationId));
  });

  app.post('/messages/:id/heart', async (c) => {
    const body = await c.req.json<{ on?: boolean }>().catch(() => ({}) as never);
    const conversationId = conversationFor(db, c.get('visitor').id);
    const row = getMessage(db, conversationId, Number(c.req.param('id')));
    if (!row || row.sender !== 'ai') return c.json({ error: 'Message not found.' }, 404);
    db.prepare('UPDATE messages SET heart_by_user = ? WHERE id = ?').run(body.on ? 1 : 0, row.id);
    return c.json({ message: await messageDTO(getMessage(db, conversationId, row.id)!) });
  });

  // "Notify me when Alisa replies": the key browsers subscribe with, and the subscriptions.
  app.get('/push', (c) => c.json({ key: push.keys.publicKey, subscribed: push.subscribed(c.get('visitor').id) }));

  app.post('/push', async (c) => {
    const body = await c.req.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>().catch(() => ({}) as never);
    const { endpoint, keys } = body;
    const valid =
      typeof endpoint === 'string' &&
      /^https:\/\//.test(endpoint) &&
      endpoint.length < 1000 &&
      typeof keys?.p256dh === 'string' &&
      typeof keys.auth === 'string' &&
      keys.p256dh.length < 200 &&
      keys.auth.length < 100;
    if (!valid) return c.json({ error: 'That isn’t a push subscription.' }, 400);
    const origin = `${isHttps(c) ? 'https' : 'http'}://${clientHost(c) ?? 'localhost'}`;
    push.subscribe(c.get('visitor').id, { endpoint, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } }, origin);
    return c.json({ subscribed: true });
  });

  app.delete('/push', async (c) => {
    const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as never);
    if (typeof body.endpoint === 'string') push.unsubscribe(c.get('visitor').id, body.endpoint);
    return c.json({ subscribed: push.subscribed(c.get('visitor').id) });
  });

  // Opening a view-once or replay photo Alisa sent. Each open uses up one view.
  app.post('/messages/:id/open', async (c) => {
    const conversationId = conversationFor(db, c.get('visitor').id);
    const row = getMessage(db, conversationId, Number(c.req.param('id')));
    if (!row || row.sender !== 'ai' || row.kind !== 'photo' || !row.media_key) {
      return c.json({ error: 'Photo not found.' }, 404);
    }
    const limit = maxViews(row.photo_mode);
    if (limit == null) return c.json({ error: 'This photo stays in the chat; open it directly.' }, 400);
    const consumed = db
      .prepare('UPDATE messages SET view_count = view_count + 1 WHERE id = ? AND view_count < ?')
      .run(row.id, limit);
    if (consumed.changes === 0) return c.json({ error: 'This photo can’t be opened again.' }, 410);
    const out: OpenPhotoDTO = {
      url: await media.url(row.media_key, 'brief'),
      seconds: config.photoSeconds,
      viewCount: row.view_count + 1,
      maxViews: limit,
    };
    return c.json(out);
  });

  // Deletes this visitor's conversation and the photos they uploaded to it.
  app.delete('/', async (c) => {
    const conversationId = conversationFor(db, c.get('visitor').id);
    const uploads = ownedUploads(listMessages(db, conversationId, 1_000_000));
    replies.drop(conversationId);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
    await Promise.all(uploads.map((k) => media.remove(k).catch(() => {})));
    return c.json(await chatState(conversationFor(db, c.get('visitor').id)));
  });

  return app;
}
