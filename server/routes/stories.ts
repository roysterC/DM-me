import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { requireUser } from '../auth';
import { conversationFor, getMessage, toMessageDTO } from '../chat';
import { nowIso } from '../db';
import { activeStoryMap, ensureStories, listStoriesFor } from '../stories';
import type { Deps } from '../app';

export function storyRoutes({ db, config }: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireUser(db));

  app.get('/', (c) => {
    ensureStories(db, config.autoStories);
    return c.json({ stories: listStoriesFor(db, c.get('user').id) });
  });

  const liveStory = (id: number) => activeStoryMap(db).get(id);

  app.post('/:id/view', (c) => {
    const story = liveStory(Number(c.req.param('id')));
    if (!story) return c.json({ error: 'Story not found.' }, 404);
    db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id, viewed_at) VALUES (?, ?, ?)').run(
      story.id,
      c.get('user').id,
      nowIso(),
    );
    return c.json({ ok: true });
  });

  app.post('/:id/like', async (c) => {
    const story = liveStory(Number(c.req.param('id')));
    if (!story) return c.json({ error: 'Story not found.' }, 404);
    const body = await c.req.json<{ on?: boolean }>().catch(() => ({}) as never);
    if (body.on) {
      db.prepare('INSERT OR IGNORE INTO story_likes (story_id, user_id) VALUES (?, ?)').run(story.id, c.get('user').id);
    } else {
      db.prepare('DELETE FROM story_likes WHERE story_id = ? AND user_id = ?').run(story.id, c.get('user').id);
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
    const conversationId = conversationFor(db, c.get('user').id);
    const snapshot = JSON.stringify({ kind: story.kind, caption: story.caption, bg: story.bg });
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender, kind, text, story_id, story_snapshot, created_at)
         VALUES (?, 'user', 'story_reply', ?, ?, ?, ?)`,
      )
      .run(conversationId, text, story.id, snapshot, nowIso());
    const row = getMessage(db, conversationId, Number(lastInsertRowid))!;
    return c.json({ message: toMessageDTO(row, activeStoryMap(db)) });
  });

  return app;
}
