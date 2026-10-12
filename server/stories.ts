import type { StoryDTO } from '../shared/types';
import { DEFAULT_STORIES, storiesPrompt } from './ai/persona';
import type { Responder } from './ai/responder';
import type { DB, StoryRow } from './db';
import { nowIso } from './db';
import { cameraRoll } from './library';
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

const HOUR = 3_600_000;
/** Alisa's day's stories look posted over the past few hours, not all at once. */
const POSTED_MINUTES_AGO = [150, 70, 15];

/**
 * Alisa's own stories, written by Claude: a new set of two or three about an hour before the
 * live ones run out, so her ring never goes empty. Stories the admin posted count, so theirs
 * come first; and if Claude can't write them, the sample stories fill in once nothing is live.
 * Returns how many were posted.
 */
export async function postDailyStories(db: DB, responder: Responder, now = Date.now()): Promise<number> {
  const { latest } = db.prepare('SELECT MAX(expires_at) AS latest FROM stories').get() as { latest: string | null };
  if (latest && Date.parse(latest) > now + HOUR) return 0;
  const { roll, byRef } = cameraRoll(db);
  const recent = (db.prepare('SELECT caption FROM stories WHERE caption IS NOT NULL ORDER BY created_at DESC LIMIT 12').all() as {
    caption: string;
  }[]).map((r) => r.caption);
  let drafts;
  try {
    drafts = await responder.writeStories(storiesPrompt(roll, recent, new Date(now)), [...byRef.keys()]);
  } catch (err) {
    console.error('Couldn’t write today’s stories', err instanceof Error ? err.message : err);
    return 0;
  }
  const insert = db.prepare(
    `INSERT INTO stories (kind, media_key, media_mime, caption, bg, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    drafts.forEach((d, i) => {
      const photo = d.photoRef ? byRef.get(d.photoRef) : undefined;
      const created = now - POSTED_MINUTES_AGO.slice(-drafts.length)[i] * 60_000;
      insert.run(
        photo ? 'photo' : 'text',
        photo?.media_key ?? null,
        photo?.media_mime ?? null,
        d.caption || null,
        photo ? null : d.bg,
        new Date(created).toISOString(),
        new Date(created + STORY_HOURS * HOUR).toISOString(),
      );
    });
  })();
  return drafts.length;
}

/** Checks every few minutes whether it's time for Alisa's next stories. */
export function scheduleStories(db: DB, responder: Responder, everyMs = 10 * 60_000) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const posted = await postDailyStories(db, responder);
      if (posted) console.log(`Alisa posted ${posted} new stories.`);
    } finally {
      busy = false;
    }
  };
  run();
  setInterval(run, everyMs).unref();
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
