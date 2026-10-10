import { Hono } from 'hono';
import { type AdminStoryDTO, type SendMode, STORY_BGS, type StoryBg } from '../../shared/types';
import type { Deps } from '../app';
import type { LibraryPhotoRow, StoryRow } from '../db';
import { nowIso } from '../db';
import { clientIp, grantAdmin, isAdmin, passwordMatches, RateLimiter, revokeAdmin } from '../identity';
import { addLibraryPhoto, listLibrary, syncLibrary, toLibraryDTO } from '../library';
import { MediaError } from '../media';
import { STORY_HOURS } from '../stories';

const SEND_MODES: SendMode[] = ['auto', 'once', 'replay', 'keep'];

/** Nova's stories and camera roll, behind ADMIN_PASSWORD. */
export function adminRoutes({ db, config, media, responder }: Deps) {
  const app = new Hono();
  const attempts = new RateLimiter(10, 10 * 60_000);
  const admin = (c: Parameters<typeof isAdmin>[0]) => isAdmin(c, config.secret, config.adminPassword);

  app.get('/me', (c) => c.json({ enabled: !!config.adminPassword, admin: admin(c), storage: media.storage.kind }));

  app.post('/login', async (c) => {
    if (!config.adminPassword) return c.json({ error: 'Set ADMIN_PASSWORD on the server to use this page.' }, 403);
    if (!attempts.take(clientIp(c))) return c.json({ error: 'Too many attempts. Wait a few minutes.' }, 429);
    const body = await c.req.json<{ password?: string }>().catch(() => ({}) as never);
    if (!passwordMatches(String(body.password ?? ''), config.adminPassword)) {
      return c.json({ error: 'Wrong password.' }, 401);
    }
    grantAdmin(c, config.secret);
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    revokeAdmin(c);
    return c.json({ ok: true });
  });

  app.use('*', async (c, next) => {
    if (!admin(c)) return c.json({ error: 'Admins only.' }, 403);
    await next();
  });

  const uploadError = (err: unknown) => {
    if (err instanceof MediaError) return err.message;
    console.error(err);
    return 'Upload failed. Check the storage settings on the server.';
  };

  // ---- Stories ----------------------------------------------------------------

  const storyDTO = async (s: StoryRow, views: number): Promise<AdminStoryDTO> => ({
    id: s.id,
    kind: s.kind,
    caption: s.caption,
    bg: s.bg,
    mediaUrl: s.media_key ? await media.url(s.media_key) : null,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    seen: false,
    liked: false,
    active: s.expires_at > nowIso(),
    views,
  });

  app.get('/stories', async (c) => {
    const rows = db.prepare('SELECT * FROM stories ORDER BY created_at DESC, id DESC LIMIT 60').all() as StoryRow[];
    const counts = new Map(
      (db.prepare('SELECT story_id, COUNT(*) n FROM story_views GROUP BY story_id').all() as { story_id: number; n: number }[]).map(
        (v) => [v.story_id, v.n],
      ),
    );
    return c.json({ stories: await Promise.all(rows.map((s) => storyDTO(s, counts.get(s.id) ?? 0))) });
  });

  app.post('/stories', async (c) => {
    const form = await c.req.parseBody();
    const kind = form.kind === 'text' ? 'text' : 'photo';
    const caption = String(form.caption ?? '').trim().slice(0, 300) || null;
    const hours = Math.min(Math.max(Number(form.hours) || STORY_HOURS, 1), 24 * 7);
    let key: string | null = null;
    let mime: string | null = null;
    let bg: StoryBg | null = null;
    if (kind === 'photo') {
      if (!(form.photo instanceof File)) return c.json({ error: 'Choose a photo for a photo story.' }, 400);
      try {
        ({ key, mime } = await media.saveFile('stories', form.photo));
      } catch (err) {
        return c.json({ error: uploadError(err) }, 400);
      }
    } else {
      if (!caption) return c.json({ error: 'A text story needs some text.' }, 400);
      bg = (STORY_BGS as string[]).includes(String(form.bg)) ? (String(form.bg) as StoryBg) : 'violet';
    }
    const created = new Date();
    const expires = new Date(created.getTime() + hours * 3_600_000);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO stories (kind, media_key, media_mime, caption, bg, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, key, mime, caption, bg, created.toISOString(), expires.toISOString());
    const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(lastInsertRowid) as StoryRow;
    return c.json({ story: await storyDTO(row, 0) });
  });

  app.delete('/stories/:id', async (c) => {
    const s = db.prepare('SELECT * FROM stories WHERE id = ?').get(Number(c.req.param('id'))) as StoryRow | undefined;
    if (!s) return c.json({ error: 'Not found.' }, 404);
    db.prepare('DELETE FROM stories WHERE id = ?').run(s.id);
    if (s.media_key) await media.remove(s.media_key).catch(() => {});
    return c.json({ ok: true });
  });

  // ---- Camera roll --------------------------------------------------------------

  app.get('/photos', async (c) => {
    const rows = listLibrary(db);
    return c.json({ photos: await Promise.all(rows.map((r) => toLibraryDTO(r, media))) });
  });

  app.post('/photos', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(form.photo ?? []).filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: 'Choose at least one photo.' }, 400);
    const description = typeof form.description === 'string' ? form.description : undefined;
    const added: LibraryPhotoRow[] = [];
    try {
      for (const file of files.slice(0, 20)) {
        added.push(
          await addLibraryPhoto(db, media, responder, new Uint8Array(await file.arrayBuffer()), files.length === 1 ? description : undefined),
        );
      }
    } catch (err) {
      return c.json({ error: uploadError(err), added: added.length }, 400);
    }
    return c.json({ photos: await Promise.all(added.map((r) => toLibraryDTO(r, media))) });
  });

  // Edits a photo's description and/or how Nova sends it.
  app.patch('/photos/:id', async (c) => {
    const body = await c.req.json<{ description?: string; sendMode?: string }>().catch(() => ({}) as never);
    const id = Number(c.req.param('id'));
    const exists = db.prepare('SELECT 1 FROM library_photos WHERE id = ? AND hidden = 0').get(id);
    if (!exists) return c.json({ error: 'Not found.' }, 404);
    if (body.description === undefined && body.sendMode === undefined) return c.json({ error: 'Nothing to change.' }, 400);
    if (body.sendMode !== undefined && !(SEND_MODES as string[]).includes(body.sendMode)) {
      return c.json({ error: 'Unknown send mode.' }, 400);
    }
    const description = body.description === undefined ? null : String(body.description).trim().slice(0, 300);
    if (description === '') return c.json({ error: 'Describe the photo so Nova knows when to send it.' }, 400);
    db.prepare(
      'UPDATE library_photos SET description = COALESCE(?, description), send_mode = COALESCE(?, send_mode) WHERE id = ?',
    ).run(description, (body.sendMode as SendMode | undefined) ?? null, id);
    return c.json({ ok: true });
  });

  app.delete('/photos/:id', async (c) => {
    const row = db.prepare('SELECT * FROM library_photos WHERE id = ?').get(Number(c.req.param('id'))) as
      | LibraryPhotoRow
      | undefined;
    if (!row) return c.json({ error: 'Not found.' }, 404);
    // Photos Nova already sent stay in those chats: keep the file and just hide it from her camera roll.
    // Samples are hidden too, so they aren't added back on the next start.
    const used = db.prepare('SELECT 1 FROM messages WHERE media_key = ? LIMIT 1').get(row.media_key);
    if (used || row.media_key.startsWith('asset:')) {
      db.prepare('UPDATE library_photos SET hidden = 1 WHERE id = ?').run(row.id);
    } else {
      db.prepare('DELETE FROM library_photos WHERE id = ?').run(row.id);
      await media.remove(row.media_key).catch(() => {});
    }
    return c.json({ ok: true });
  });

  app.post('/photos/sync', async (c) => {
    try {
      return c.json(await syncLibrary(db, media, responder));
    } catch (err) {
      console.error(err);
      return c.json({ error: 'Couldn’t read the bucket. Check the storage settings on the server.' }, 502);
    }
  });

  return app;
}
