import type { MessageDTO, ReplyRefDTO, StoryRefDTO } from '../shared/types';
import { buildConversation, messageRef } from './ai/context';
import { systemPrompt } from './ai/persona';
import type { Responder } from './ai/responder';
import type { DB, MessageRow, StoryRow } from './db';
import { nowIso } from './db';
import { cameraRoll } from './library';
import type { MediaStore } from './media';
import { type Bubble, schedule, splitBubbles } from './pacing';

const HISTORY_LIMIT = 80;

export function conversationFor(db: DB, visitorId: number): number {
  const existing = db.prepare('SELECT id FROM conversations WHERE visitor_id = ?').get(visitorId) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  // The chat starts empty: Alisa waits for the visitor to text first.
  const { lastInsertRowid } = db
    .prepare('INSERT INTO conversations (visitor_id, created_at) VALUES (?, ?)')
    .run(visitorId, nowIso());
  return Number(lastInsertRowid);
}

/**
 * The conversation in the order messages appear. Alisa's bubbles carry the time
 * they're due to appear, which can be in the future while she's "typing"; a
 * message the visitor sends meanwhile sorts before them.
 */
export function listMessages(db: DB, conversationId: number, limit = 500): MessageRow[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse();
}

/**
 * The chat in the order Alisa experienced it, which is what her history must follow. A message
 * the visitor sends while she's thinking or "typing" isn't read until her next reply, so it goes
 * after what she wrote in the meantime, even though it was sent (and shows) earlier. Older rows
 * without a sequence number keep their insertion order; unread messages always come last.
 */
export function contextOrder(rows: MessageRow[]): MessageRow[] {
  const rank = (r: MessageRow) => (r.context_seq != null ? 1 : r.sender === 'user' && !r.read_at ? 2 : 0);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.context_seq ?? 0) - (b.context_seq ?? 0) || a.id - b.id);
}

/** Splits rows into those already showing and the times (ms from now) the rest are due. */
export function splitDue(rows: MessageRow[], now = Date.now()): { shown: MessageRow[]; upcoming: number[] } {
  const cutoff = new Date(now).toISOString();
  return {
    shown: rows.filter((r) => r.created_at <= cutoff),
    upcoming: rows.filter((r) => r.created_at > cutoff).map((r) => Date.parse(r.created_at) - now),
  };
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

/** Keys of uploaded photos that only this conversation uses (Alisa's camera roll is shared). */
export function ownedUploads(rows: MessageRow[]): string[] {
  return rows.filter((r) => r.sender === 'user' && r.media_key?.startsWith('uploads/')).map((r) => r.media_key!);
}

/** What a reply shows of the message it quotes. */
export function replyRef(quoted: MessageRow | undefined): ReplyRefDTO | null {
  if (!quoted) return null;
  return { id: quoted.id, sender: quoted.sender, text: quoted.kind === 'photo' ? null : quoted.text, photo: quoted.kind === 'photo' };
}

export async function toMessageDTO(
  r: MessageRow,
  activeStories: Map<number, StoryRow>,
  media: MediaStore,
  lookup: (id: number) => MessageRow | undefined = () => undefined,
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
    replyTo: r.reply_to_id != null ? replyRef(lookup(r.reply_to_id)) : null,
  };
}

/**
 * Generates Alisa's reply to everything the visitor has sent since her last
 * message. One reply runs per conversation at a time.
 */
export class ReplyService {
  private running = new Map<number, { job: Promise<void>; dropped: boolean }>();

  constructor(
    private db: DB,
    private media: MediaStore,
    private responder: Responder,
    /** Typing speed for reply timing; 0 shows every bubble as soon as the reply is ready. */
    private charsPerSecond = 0,
  ) {}

  async replyTo(conversationId: number, timeZone: string): Promise<boolean> {
    const inflight = this.running.get(conversationId);
    if (inflight) {
      await inflight.job.catch(() => {});
      return false;
    }
    let replied = false;
    const entry = { job: Promise.resolve(), dropped: false };
    entry.job = this.run(conversationId, timeZone, () => entry.dropped)
      .then((r) => {
        replied = r;
      })
      .finally(() => this.running.delete(conversationId));
    this.running.set(conversationId, entry);
    await entry.job;
    return replied;
  }

  /** The chat is being deleted: a reply still being written for it is thrown away. */
  drop(conversationId: number) {
    const inflight = this.running.get(conversationId);
    if (inflight) inflight.dropped = true;
  }

  /** The next number in this chat's experienced order (see contextOrder). */
  private nextSeq(conversationId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(context_seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { n: number };
    return row.n;
  }

  private async run(conversationId: number, timeZone: string, dropped: () => boolean): Promise<boolean> {
    const startedAt = Date.now();
    const before = contextOrder(listMessages(this.db, conversationId, HISTORY_LIMIT));
    const lastUserBefore = before.findLast((r) => r.sender === 'user');
    if (!lastUserBefore) return false;
    // Reply to anything unread, or retry when the last attempt failed after reading it.
    const lastAiBefore = before.findLast((r) => r.sender === 'ai');
    const unread = before.some((r) => r.sender === 'user' && !r.read_at);
    if (!unread && lastAiBefore && before.indexOf(lastAiBefore) > before.indexOf(lastUserBefore)) return false;

    // Read everything new, numbering it in the order she reads it.
    this.db.transaction(() => {
      const unreadIds = this.db
        .prepare("SELECT id FROM messages WHERE conversation_id = ? AND sender = 'user' AND read_at IS NULL ORDER BY id")
        .all(conversationId) as { id: number }[];
      let seq = this.nextSeq(conversationId);
      const now = nowIso();
      const markRead = this.db.prepare('UPDATE messages SET read_at = ?, context_seq = ? WHERE id = ?');
      for (const { id } of unreadIds) markRead.run(now, seq++, id);
    })();
    const rows = contextOrder(listMessages(this.db, conversationId, HISTORY_LIMIT));
    const lastUser = rows.findLast((r) => r.sender === 'user')!;

    const { roll, byRef, refByKey } = cameraRoll(this.db);
    const { messages, opening } = await buildConversation(rows, this.media, timeZone, refByKey, (id) =>
      getMessage(this.db, conversationId, id),
    );
    const reply = await this.responder.reply({ system: systemPrompt(roll), messages, photoRefs: [...byRef.keys()] });

    const insertText = this.db.prepare(
      `INSERT INTO messages (conversation_id, sender, kind, text, reply_to_id, created_at, context_seq)
       VALUES (?, 'ai', 'text', ?, ?, ?, ?)`,
    );
    const insertPhoto = this.db.prepare(
      `INSERT INTO messages (conversation_id, sender, kind, media_key, media_mime, media_width, media_height, photo_mode, reply_to_id, created_at, context_seq)
       VALUES (?, 'ai', 'photo', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Her first bubble can quote one of the visitor's messages; anything else she names is ignored.
    const quoted = reply.replyTo
      ? (rows.find((r) => r.sender === 'user' && messageRef(r.id) === reply.replyTo)?.id ?? null)
      : null;
    const quoteFor = (i: number) => (i === 0 ? quoted : null);
    const keyOf = this.db.prepare('SELECT media_key FROM messages WHERE id = ?');
    const markOpened = this.db.prepare('UPDATE messages SET view_count = view_count + 1 WHERE id = ?');

    const toDelete: string[] = [];
    const saved = this.db.transaction(() => {
      // The visitor deleted the chat while Alisa was writing: nothing to add it to. (Checked by
      // flag, not by id: the visitor's new chat can be given the deleted one's id.)
      if (dropped() || !this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return false;
      // Alisa has now seen the view-once photos; they can't be opened again.
      for (const id of opening) {
        markOpened.run(id);
        const row = keyOf.get(id) as { media_key: string | null } | undefined;
        if (row?.media_key) toDelete.push(row.media_key);
      }
      if (reply.heartLatest) this.db.prepare('UPDATE messages SET heart_by_ai = 1 WHERE id = ?').run(lastUser.id);

      // Text bubbles first ("Like this:"), then the photo, each due when it would be typed.
      const texts = splitBubbles(reply.messages);
      // Only if it's still in the camera roll: the admin may have removed it (and its file)
      // while she was writing.
      const picked = reply.photo ? byRef.get(reply.photo.ref) : undefined;
      const p =
        picked && this.db.prepare('SELECT 1 FROM library_photos WHERE id = ? AND hidden = 0').get(picked.id) ? picked : undefined;
      const bubbles: Bubble[] = texts.map((text) => ({ kind: 'text', text }));
      if (p) bubbles.push({ kind: 'photo' });
      // Bubbles still due from an earlier reply go first.
      const pendingUntil = Math.max(0, ...rows.filter((r) => r.sender === 'ai').map((r) => Date.parse(r.created_at)));
      const times = schedule(bubbles, {
        charsPerSecond: this.charsPerSecond,
        startedAt,
        readyAt: Date.now(),
        notBefore: pendingUntil > startedAt ? pendingUntil : 0,
      });
      const at = (i: number) => new Date(times[i]).toISOString();
      // Her bubbles take their place in the experienced order as she writes them.
      const firstSeq = this.nextSeq(conversationId);
      texts.forEach((text, i) => insertText.run(conversationId, text, quoteFor(i), at(i), firstSeq + i));
      if (reply.photo && p) {
        // A photo set to always go out one way on the admin page overrides Alisa's choice.
        const mode = p.send_mode === 'auto' ? reply.photo.mode : p.send_mode;
        insertPhoto.run(
          conversationId,
          p.media_key,
          p.media_mime,
          p.width,
          p.height,
          mode,
          quoteFor(texts.length),
          at(texts.length),
          firstSeq + texts.length,
        );
      }
      return true;
    })();
    if (!saved) return false;
    await Promise.all(toDelete.map((k) => this.media.remove(k).catch((err) => console.error('Delete failed', k, err))));
    return true;
  }
}
