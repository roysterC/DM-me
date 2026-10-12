import { listMessages, ownedUploads } from './chat';
import type { DB } from './db';
import { VISITOR_COOKIE_DAYS } from './identity';
import type { MediaStore } from './media';

const DAY = 86_400_000;
/** A visitor who never sent anything is forgotten after this long away (their story views and likes go too). */
export const EMPTY_VISITOR_DAYS = 30;

export interface Pruned {
  emptyVisitors: number;
  expiredVisitors: number;
  photos: number;
  replyCounts: number;
}

/**
 * Every browser that reaches the API gets a visitor row (and opening the chat makes an empty
 * conversation), so without this the database grows with every bot and one-time visit. Removes:
 * - visitors who never sent a message and haven't been back for EMPTY_VISITOR_DAYS;
 * - visitors whose cookie has expired, with their chat and the photos they sent: nobody can open
 *   that chat any more;
 * - per-visitor reply counts from past days (only today's count is ever read).
 */
export async function pruneVisitors(db: DB, media: MediaStore, now = Date.now()): Promise<Pruned> {
  const iso = (ms: number) => new Date(ms).toISOString();
  // A day of margin past the cookie's lifetime, which is renewed while the visitor keeps coming back.
  const expiredBefore = iso(now - (VISITOR_COOKIE_DAYS + 1) * DAY);

  const conversations = db
    .prepare('SELECT c.id FROM conversations c JOIN visitors v ON v.id = c.visitor_id WHERE v.last_seen_at < ?')
    .all(expiredBefore) as { id: number }[];
  const photos = conversations.flatMap((c) => ownedUploads(listMessages(db, c.id, 1_000_000)));

  const { emptyVisitors, expiredVisitors, replyCounts } = db.transaction(() => ({
    expiredVisitors: db.prepare('DELETE FROM visitors WHERE last_seen_at < ?').run(expiredBefore).changes,
    emptyVisitors: db
      .prepare(
        `DELETE FROM visitors WHERE last_seen_at < ? AND NOT EXISTS (
           SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.visitor_id = visitors.id
         )`,
      )
      .run(iso(now - EMPTY_VISITOR_DAYS * DAY)).changes,
    replyCounts: db.prepare('DELETE FROM reply_counts WHERE day < ?').run(iso(now).slice(0, 10)).changes,
  }))();

  for (const key of photos) await media.remove(key).catch(() => {});
  return { emptyVisitors, expiredVisitors, photos: photos.length, replyCounts };
}

/** Prunes now and then every few hours, logging what it removed. */
export function scheduleCleanup(db: DB, media: MediaStore, everyMs = 6 * 3_600_000) {
  const run = () =>
    pruneVisitors(db, media)
      .then((p) => {
        if (p.emptyVisitors || p.expiredVisitors) {
          console.log(
            `Cleanup: removed ${p.emptyVisitors} visitors who never sent a message and ${p.expiredVisitors} with expired cookies (${p.photos} photos).`,
          );
        }
      })
      .catch((err) => console.error('Cleanup failed', err));
  run();
  setInterval(run, everyMs).unref();
}
