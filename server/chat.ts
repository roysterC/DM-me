import type { MessageDTO, StoryRefDTO } from '../shared/types';
import { buildConversation } from './ai/context';
import { GREETING, systemPrompt } from './ai/nova';
import type { Responder } from './ai/responder';
import type { DB, MessageRow, StoryRow } from './db';
import { nowIso } from './db';
import { cameraRoll } from './library';
import type { MediaStore } from './media';

const HISTORY_LIMIT = 80;

export function conversationFor(db: DB, visitorId: number): number {
  const existing = db.prepare('SELECT id FROM conversations WHERE visitor_id = ?').get(visitorId) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const now = nowIso();
  return db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO conversations (visitor_id, created_at) VALUES (?, ?)')
      .run(visitorId, now);
    const id = Number(lastInsertRowid);
    db.prepare(
      "INSERT INTO messages (conversation_id, sender, kind, text, created_at) VALUES (?, 'ai', 'text', ?, ?)",
    ).run(id, GREETING, now);
    return id;
  })();
}

export function listMessages(db: DB, conversationId: number, limit = 500): MessageRow[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse();
}

export function getMessage(db: DB, conversationId: number, id: number): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(id, conversationId) as
    | MessageRow
    | undefined;
}

export function maxViews(mode: string | null): number | null {
  if (mode === 'once') return 1;
  if (mode === 'replay') return 2;
  return null;
}

/** Keys of uploaded photos that only this conversation uses (Nova's camera roll is shared). */
export function ownedUploads(rows: MessageRow[]): string[] {
  return rows.filter((r) => r.sender === 'user' && r.media_key?.startsWith('uploads/')).map((r) => r.media_key!);
}

export async function toMessageDTO(
  r: MessageRow,
  activeStories: Map<number, StoryRow>,
  media: MediaStore,
): Promise<MessageDTO> {
  let story: StoryRefDTO | null = null;
  if (r.kind === 'story_reply' && r.story_snapshot) {
    const snap = JSON.parse(r.story_snapshot) as Pick<StoryRow, 'kind' | 'caption' | 'bg'>;
    const live = r.story_id != null ? activeStories.get(r.story_id) : undefined;
    story = {
      id: r.story_id ?? 0,
      kind: snap.kind,
      caption: snap.caption,
      bg: snap.bg,
      available: !!live,
      thumbUrl: live?.kind === 'photo' && live.media_key ? await media.url(live.media_key) : null,
    };
  }
  const photo =
    r.kind === 'photo'
      ? {
          mode: r.photo_mode ?? 'keep',
          url: r.photo_mode === 'keep' && r.media_key ? await media.url(r.media_key) : null,
          width: r.media_width,
          height: r.media_height,
          viewCount: r.view_count,
          maxViews: maxViews(r.photo_mode),
        }
      : null;
  return {
    id: r.id,
    sender: r.sender,
    kind: r.kind,
    text: r.text,
    createdAt: r.created_at,
    readAt: r.read_at,
    heartByUser: r.heart_by_user === 1,
    heartByAi: r.heart_by_ai === 1,
    photo,
    story,
  };
}

/**
 * Generates Nova's reply to everything the visitor has sent since her last
 * message. One reply runs per conversation at a time.
 */
export class ReplyService {
  private running = new Map<number, Promise<void>>();

  constructor(
    private db: DB,
    private media: MediaStore,
    private responder: Responder,
  ) {}

  async replyTo(conversationId: number, timeZone: string): Promise<boolean> {
    const inflight = this.running.get(conversationId);
    if (inflight) {
      await inflight.catch(() => {});
      return false;
    }
    let replied = false;
    const job = this.run(conversationId, timeZone)
      .then((r) => {
        replied = r;
      })
      .finally(() => this.running.delete(conversationId));
    this.running.set(conversationId, job);
    await job;
    return replied;
  }

  private async run(conversationId: number, timeZone: string): Promise<boolean> {
    const rows = listMessages(this.db, conversationId, HISTORY_LIMIT);
    const last = rows[rows.length - 1];
    if (!last || last.sender !== 'user') return false;

    this.db
      .prepare("UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender = 'user' AND read_at IS NULL")
      .run(nowIso(), conversationId);

    const { roll, byRef, refByKey } = cameraRoll(this.db);
    const { messages, opening } = await buildConversation(rows, this.media, timeZone, refByKey);
    const reply = await this.responder.reply({ system: systemPrompt(roll), messages, photoRefs: [...byRef.keys()] });

    const insertText = this.db.prepare(
      "INSERT INTO messages (conversation_id, sender, kind, text, created_at) VALUES (?, 'ai', 'text', ?, ?)",
    );
    const insertPhoto = this.db.prepare(
      `INSERT INTO messages (conversation_id, sender, kind, media_key, media_mime, media_width, media_height, photo_mode, created_at)
       VALUES (?, 'ai', 'photo', ?, ?, ?, ?, ?, ?)`,
    );
    const keyOf = this.db.prepare('SELECT media_key FROM messages WHERE id = ?');
    const markOpened = this.db.prepare('UPDATE messages SET view_count = view_count + 1 WHERE id = ?');

    const toDelete: string[] = [];
    this.db.transaction(() => {
      // Nova has now seen the view-once photos; they can't be opened again.
      for (const id of opening) {
        markOpened.run(id);
        const row = keyOf.get(id) as { media_key: string | null } | undefined;
        if (row?.media_key) toDelete.push(row.media_key);
      }
      if (reply.heartLatest) this.db.prepare('UPDATE messages SET heart_by_ai = 1 WHERE id = ?').run(last.id);

      // Text bubbles first ("Like this:"), then the photo.
      const now = nowIso();
      for (const text of reply.messages) insertText.run(conversationId, text, now);
      const p = reply.photo ? byRef.get(reply.photo.ref) : undefined;
      if (reply.photo && p) {
        // A photo set to always go out one way on the admin page overrides Nova's choice.
        const mode = p.send_mode === 'auto' ? reply.photo.mode : p.send_mode;
        insertPhoto.run(conversationId, p.media_key, p.media_mime, p.width, p.height, mode, now);
      }
    })();
    await Promise.all(toDelete.map((k) => this.media.remove(k).catch((err) => console.error('Delete failed', k, err))));
    return true;
  }
}
