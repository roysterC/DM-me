import { Hono } from 'hono';
import { STORY_BGS, type StoryBg, type StoryDTO } from '../../shared/types';
import { NOVA } from '../ai/nova';
import type { AppEnv } from '../auth';
import { requireUser } from '../auth';
import type { StoryRow } from '../db';
import { nowIso } from '../db';
import { MediaError } from '../media';
import { STORY_HOURS } from '../stories';
import type { Deps } from '../app';

/** Story management for usernames listed in ADMIN_USERNAMES. */
export function adminRoutes({ db, config, media }: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireUser(db));
  app.use('*', async (c, next) => {
    if (!config.adminUsernames.has(c.get('user').username.toLowerCase())) {
      return c.json({ error: 'Admins only.' }, 403);
    }
    await next();
  });

  const toDTO = (s: StoryRow): StoryDTO & { active: boolean } => ({
    id: s.id,
    kind: s.kind,
    caption: s.caption,
    bg: s.bg,
    mediaUrl: s.kind === 'photo' ? `/api/admin/stories/${s.id}/media` : null,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    seen: false,
    liked: false,
    active: s.expires_at > nowIso(),
  });

  app.get('/stories', (c) => {
    const rows = db
      .prepare('SELECT * FROM stories WHERE persona_id = ? ORDER BY created_at DESC, id DESC LIMIT 60')
      .all(NOVA.id) as StoryRow[];
    const views = db.prepare('SELECT story_id, COUNT(*) n FROM story_views GROUP BY story_id').all() as {
      story_id: number;
      n: number;
    }[];
    const counts = new Map(views.map((v) => [v.story_id, v.n]));
    return c.json({ stories: rows.map((s) => ({ ...toDTO(s), views: counts.get(s.id) ?? 0 })) });
  });

  app.get('/stories/:id/media', (c) => {
    const s = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(c.req.param('id'))) as StoryRow | undefined;
    const data = s?.media_file ? media.read(s.media_file) : null;
    if (!s || !data) return c.json({ error: 'Not found.' }, 404);
    return c.body(new Uint8Array(data), 200, { 'Content-Type': s.media_mime ?? 'image/jpeg', 'Cache-Control': 'no-store' });
  });

  app.post('/stories', async (c) => {
    const form = await c.req.parseBody();
    const kind = form.kind === 'text' ? 'text' : 'photo';
    const caption = String(form.caption ?? '').trim().slice(0, 300) || null;
    const hours = Math.min(Math.max(Number(form.hours) || STORY_HOURS, 1), 24 * 7);
    let file: string | null = null;
    let mime: string | null = null;
    let bg: StoryBg | null = null;
    if (kind === 'photo') {
      if (!(form.photo instanceof File)) return c.json({ error: 'Choose a photo for a photo story.' }, 400);
      try {
        const saved = await media.saveUpload(form.photo);
        file = saved.name;
        mime = saved.mime;
      } catch (err) {
        if (err instanceof MediaError) return c.json({ error: err.message }, 400);
        throw err;
      }
    } else {
      if (!caption) return c.json({ error: 'A text story needs some text.' }, 400);
      bg = (STORY_BGS as string[]).includes(String(form.bg)) ? (String(form.bg) as StoryBg) : 'violet';
    }
    const created = new Date();
    const expires = new Date(created.getTime() + hours * 3_600_000);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO stories (persona_id, kind, media_file, media_mime, caption, bg, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(NOVA.id, kind, file, mime, caption, bg, created.toISOString(), expires.toISOString());
    const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(lastInsertRowid) as StoryRow;
    return c.json({ story: toDTO(row) });
  });

  app.delete('/stories/:id', (c) => {
    const s = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(c.req.param('id'))) as StoryRow | undefined;
    if (!s) return c.json({ error: 'Not found.' }, 404);
    db.prepare('DELETE FROM stories WHERE id = ?').run(s.id);
    if (s.media_file) media.remove(s.media_file);
    return c.json({ ok: true });
  });

  return app;
}
