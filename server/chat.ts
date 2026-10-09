import type { MessageDTO, StoryRefDTO } from '../shared/types';
import { buildConversation } from './ai/context';
import { CAMERA_ROLL, GREETING, NOVA, systemPrompt } from './ai/nova';
import type { Responder } from './ai/responder';
import type { DB, MessageRow, StoryRow, UserRow } from './db';
import { nowIso } from './db';
import type { MediaStore } from './media';

const HISTORY_LIMIT = 80;

export function conversationFor(db: DB, userId: number): number {
  const existing = db
    .prepare('SELECT id FROM conversations WHERE user_id = ? AND persona_id = ?')
    .get(userId, NOVA.id) as { id: number } | undefined;
  if (existing) return existing.id;
  const now = nowIso();
  return db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO conversations (user_id, persona_id, created_at) VALUES (?, ?, ?)')
      .run(userId, NOVA.id, now);
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

export function toMessageDTO(r: MessageRow, activeStories: Map<number, StoryRow>): MessageDTO {
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
      thumbUrl: live && live.kind === 'photo' ? `/api/media/story/${live.id}` : null,
    };
  }
  const photo =
    r.kind === 'photo'
      ? {
          mode: r.photo_mode ?? 'keep',
          url: r.photo_mode === 'keep' && r.media_file ? `/api/media/message/${r.id}` : null,
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

export class ReplyInProgress extends Error {}

/**
 * Generates Nova's reply to everything the user has sent since her last
 * message. One reply runs per conversation at a time.
 */
export class ReplyService {
  private running = new Map<number, Promise<void>>();

  constructor(
    private db: DB,
    private media: MediaStore,
    private responder: Responder,
  ) {}

  async replyTo(user: UserRow, conversationId: number, timeZone: string): Promise<void> {
    const inflight = this.running.get(conversationId);
    if (inflight) {
      await inflight.catch(() => {});
      return;
    }
    const job = this.run(user, conversationId, timeZone).finally(() => this.running.delete(conversationId));
    this.running.set(conversationId, job);
    await job;
  }

  private async run(user: UserRow, conversationId: number, timeZone: string) {
    const rows = listMessages(this.db, conversationId, HISTORY_LIMIT);
    const last = rows[rows.length - 1];
    if (!last || last.sender !== 'user') return;

    this.db
      .prepare("UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender = 'user' AND read_at IS NULL")
      .run(nowIso(), conversationId);

    const { messages, opening } = buildConversation(rows, this.media, timeZone);
    const reply = await this.responder.reply({ system: systemPrompt(user.username), messages });

    const insertText = this.db.prepare(
      "INSERT INTO messages (conversation_id, sender, kind, text, created_at) VALUES (?, 'ai', 'text', ?, ?)",
    );
    const insertPhoto = this.db.prepare(
      `INSERT INTO messages (conversation_id, sender, kind, media_file, media_mime, media_width, media_height, photo_mode, created_at)
       VALUES (?, 'ai', 'photo', ?, 'image/jpeg', ?, ?, ?, ?)`,
    );
    const opened = this.db.prepare('SELECT media_file FROM messages WHERE id = ?');
    const markOpened = this.db.prepare('UPDATE messages SET view_count = view_count + 1 WHERE id = ?');

    const filesToDelete: string[] = [];
    this.db.transaction(() => {
      // Nova has now seen the view-once photos; they can't be opened again.
      for (const id of opening) {
        markOpened.run(id);
        const row = opened.get(id) as { media_file: string | null } | undefined;
        if (row?.media_file) filesToDelete.push(row.media_file);
      }
      if (reply.heartLatest) this.db.prepare('UPDATE messages SET heart_by_ai = 1 WHERE id = ?').run(last.id);

      // Text bubbles first ("Like this:"), then the photo.
      const now = nowIso();
      for (const text of reply.messages) insertText.run(conversationId, text, now);
      if (reply.photo) {
        const p = CAMERA_ROLL.find((x) => x.id === reply.photo!.id)!;
        insertPhoto.run(conversationId, p.file, p.width, p.height, reply.photo.mode, now);
      }
    })();
    for (const f of filesToDelete) this.media.remove(f);
  }
}
