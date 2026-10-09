import { Hono } from 'hono';
import type { Deps } from '../app';
import { conversationFor, getMessage, toMessageDTO } from '../chat';
import { nowIso } from '../db';
import type { AppEnv } from '../identity';
import { activeStoryMap, ensureStories, listStoriesFor } from '../stories';

export function storyRoutes({ db, config, media }: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    ensureStories(db, config.autoStories);
    return c.json({ stories: await listStoriesFor(db, media, c.get('visitor').id) });
  });

  const liveStory = (id: number) => activeStoryMap(db).get(id);

  app.post('/:id/view', (c) => {
    const story = liveStory(Number(c.req.param('id')));
    if (!story) return c.json({ error: 'Story not found.' }, 404);
    db.prepare('INSERT OR IGNORE INTO story_views (story_id, visitor_id, viewed_at) VALUES (?, ?, ?)').run(
      story.id,
      c.get('visitor').id,
      nowIso(),
    );
    return c.json({ ok: true });
  });

  app.post('/:id/like', async (c) => {
    const story = liveStory(Number(c.req.param('id')));
    if (!story) return c.json({ error: 'Story not found.' }, 404);
    const body = await c.req.json<{ on?: boolean }>().catch(() => ({}) as never);
    const visitorId = c.get('visitor').id;
    if (body.on) {
      db.prepare('INSERT OR IGNORE INTO story_likes (story_id, visitor_id) VALUES (?, ?)').run(story.id, visitorId);
    } else {
      db.prepare('DELETE FROM story_likes WHERE story_id = ? AND visitor_id = ?').run(story.id, visitorId);
    }
    return c.json({ liked: !!body.on });
  });

  // Replying to a story sends a DM that quotes it, like Instagram's "Replied to their story".
  app.post('/:id/reply', async (c) => {
    const story = liveStory(Number(c.req.param('id')));
    if (!story) return c.json({ error: 'That story has expired.' }, 404);
    const body = await c.req.json<{ text?: string }>().catch(() => ({}) as never);
    const text = String(body.text ?? '').trim();
    if (!text || text.length > 2000) return c.json({ error: 'Write a reply first.' }, 400);
    const conversationId = conversationFor(db, c.get('visitor').id);
    const snapshot = JSON.stringify({ kind: story.kind, caption: story.caption, bg: story.bg });
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender, kind, text, story_id, story_snapshot, created_at)
         VALUES (?, 'user', 'story_reply', ?, ?, ?, ?)`,
      )
      .run(conversationId, text, story.id, snapshot, nowIso());
    const row = getMessage(db, conversationId, Number(lastInsertRowid))!;
    return c.json({ message: await toMessageDTO(row, activeStoryMap(db), media) });
  });

  return app;
}
