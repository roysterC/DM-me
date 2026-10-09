import type { StoryDTO } from '../shared/types';
import { DEFAULT_STORIES, NOVA } from './ai/nova';
import type { DB, StoryRow } from './db';
import { nowIso } from './db';

export const STORY_HOURS = 24;

export function activeStories(db: DB): StoryRow[] {
  return db
    .prepare('SELECT * FROM stories WHERE persona_id = ? AND expires_at > ? ORDER BY created_at, id')
    .all(NOVA.id, nowIso()) as StoryRow[];
}

export function activeStoryMap(db: DB): Map<number, StoryRow> {
  return new Map(activeStories(db).map((s) => [s.id, s]));
}

/** Posts Nova's default stories again whenever none are live, so the ring never goes empty. */
export function ensureStories(db: DB, enabled: boolean) {
  if (!enabled || activeStories(db).length > 0) return;
  const insert = db.prepare(
    `INSERT INTO stories (persona_id, kind, media_file, media_mime, caption, bg, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const s of DEFAULT_STORIES) {
      const created = new Date(Date.now() - s.minutesAgo * 60_000);
      const expires = new Date(created.getTime() + STORY_HOURS * 3_600_000);
      insert.run(
        NOVA.id,
        s.kind,
        s.file ?? null,
        s.file ? 'image/jpeg' : null,
        s.caption,
        s.bg ?? null,
        created.toISOString(),
        expires.toISOString(),
      );
    }
  })();
}

export function listStoriesFor(db: DB, userId: number): StoryDTO[] {
  const seen = new Set(
    (db.prepare('SELECT story_id FROM story_views WHERE user_id = ?').all(userId) as { story_id: number }[]).map(
      (r) => r.story_id,
    ),
  );
  const liked = new Set(
    (db.prepare('SELECT story_id FROM story_likes WHERE user_id = ?').all(userId) as { story_id: number }[]).map(
      (r) => r.story_id,
    ),
  );
  return activeStories(db).map((s) => ({
    id: s.id,
    kind: s.kind,
    caption: s.caption,
    bg: s.bg,
    mediaUrl: s.kind === 'photo' ? `/api/media/story/${s.id}` : null,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    seen: seen.has(s.id),
    liked: liked.has(s.id),
  }));
}
