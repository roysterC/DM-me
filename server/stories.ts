import type { StoryDTO } from '../shared/types';
import { DEFAULT_STORIES } from './ai/persona';
import type { DB, StoryRow } from './db';
import { nowIso } from './db';
import type { MediaStore } from './media';

export const STORY_HOURS = 24;

export function activeStories(db: DB): StoryRow[] {
  return db.prepare('SELECT * FROM stories WHERE expires_at > ? ORDER BY created_at, id').all(nowIso()) as StoryRow[];
}

export function activeStoryMap(db: DB): Map<number, StoryRow> {
  return new Map(activeStories(db).map((s) => [s.id, s]));
}

/** Posts Alisa's sample stories again whenever none are live, so the ring never goes empty. */
export function ensureStories(db: DB, enabled: boolean) {
  if (!enabled || activeStories(db).length > 0) return;
  const insert = db.prepare(
    `INSERT INTO stories (kind, media_key, media_mime, caption, bg, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const s of DEFAULT_STORIES) {
      const created = new Date(Date.now() - s.minutesAgo * 60_000);
      const expires = new Date(created.getTime() + STORY_HOURS * 3_600_000);
      insert.run(s.kind, s.key ?? null, s.key ? 'image/jpeg' : null, s.caption, s.bg ?? null, created.toISOString(), expires.toISOString());
    }
  })();
}

export async function listStoriesFor(db: DB, media: MediaStore, visitorId: number): Promise<StoryDTO[]> {
  const ids = (table: string) =>
    new Set(
      (db.prepare(`SELECT story_id FROM ${table} WHERE visitor_id = ?`).all(visitorId) as { story_id: number }[]).map(
        (r) => r.story_id,
      ),
    );
  const seen = ids('story_views');
  const liked = ids('story_likes');
  return Promise.all(
    activeStories(db).map(async (s) => ({
      id: s.id,
      kind: s.kind,
      caption: s.caption,
      bg: s.bg,
      mediaUrl: s.kind === 'photo' && s.media_key ? await media.url(s.media_key) : null,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      seen: seen.has(s.id),
      liked: liked.has(s.id),
    })),
  );
}
