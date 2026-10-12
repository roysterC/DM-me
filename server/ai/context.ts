import type Anthropic from '@anthropic-ai/sdk';
import type { MessageRow } from '../db';
import type { MediaStore } from '../media';

type Block = Anthropic.ContentBlockParam;
type Turn = Anthropic.MessageParam;
type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const MAX_IMAGES = 12;
/**
 * Photo bytes sent to Claude per reply, newest first. Requests are capped at 32 MB and images
 * travel as base64 (a third bigger); photos past this are mentioned instead of attached.
 */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const QUOTE_CHARS = 140;

/** How Alisa refers to one of the visitor's messages, e.g. to quote-reply to it. */
export const messageRef = (id: number) => `m${id}`;

export function formatStamp(iso: string, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(iso)) + ' UTC';
  }
}

/**
 * Turns stored chat rows into a Claude conversation. User rows become text and
 * image blocks; Alisa's rows become the JSON replies she produced. Returns the
 * ids of view-once photos Alisa is seeing for the first (and only) time.
 *
 * `refByKey` maps camera-roll photo keys to the references Alisa uses for them.
 */
export async function buildConversation(
  rows: MessageRow[],
  media: Pick<MediaStore, 'read'>,
  timeZone: string,
  refByKey: Map<string, string>,
  lookup?: (id: number) => MessageRow | undefined,
): Promise<{ messages: Turn[]; opening: number[] }> {
  const opening: number[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const find = (id: number) => byId.get(id) ?? lookup?.(id);

  // Decide which user photos are shown as images, newest first, within the caps. A view-once
  // photo that doesn't fit stays unopened for the next reply.
  const images = new Map<number, Uint8Array>();
  let bytes = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.sender !== 'user' || r.kind !== 'photo' || !r.media_key) continue;
    const ephemeral = r.photo_mode !== 'keep';
    if (ephemeral && r.view_count > 0) continue;
    if (!ephemeral && images.size >= MAX_IMAGES) continue;
    const data = await media.read(r.media_key);
    if (!data || bytes + data.byteLength > MAX_IMAGE_BYTES) continue;
    bytes += data.byteLength;
    images.set(r.id, data);
    if (ephemeral) opening.push(r.id);
  }

  const turns: Turn[] = [];
  let i = 0;
  while (i < rows.length) {
    const start = i;
    const sender = rows[i].sender;
    const group: MessageRow[] = [];
    while (i < rows.length && rows[i].sender === sender) group.push(rows[i++]);

    if (sender === 'user') {
      const blocks: Block[] = [];
      for (const r of group) blocks.push(...userBlocks(r, images.get(r.id), timeZone, find));
      turns.push({ role: 'user', content: blocks });
    } else {
      turns.push({ role: 'assistant', content: assistantJson(group, lastUserRow(rows, start), refByKey) });
    }
  }

  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(opened the chat)' });
  return { messages: turns, opening };
}

/** "(replying to your message: ...)" when the visitor quote-replied to something. */
function quoteNote(r: MessageRow, find: (id: number) => MessageRow | undefined): string {
  if (r.reply_to_id == null) return '';
  const q = find(r.reply_to_id);
  const whose = q?.sender === 'user' ? 'their own' : 'your';
  if (!q) return '(replying to an earlier message) ';
  if (q.kind === 'photo') return `(replying to ${whose} photo) `;
  const text = (q.text ?? '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text;
  return `(replying to ${whose} message: "${clipped}") `;
}

function userBlocks(
  r: MessageRow,
  image: Uint8Array | undefined,
  timeZone: string,
  find: (id: number) => MessageRow | undefined,
): Block[] {
  const stamp = `[${messageRef(r.id)} · ${formatStamp(r.created_at, timeZone)}] ${quoteNote(r, find)}`.trimEnd();
  if (r.kind === 'text') return [{ type: 'text', text: `${stamp} ${visitorText(r.text)}` }];

  if (r.kind === 'story_reply') {
    const story = r.story_snapshot ? (JSON.parse(r.story_snapshot) as { caption?: string | null }) : {};
    const caption = story.caption ? `"${story.caption}"` : '(no caption)';
    return [{ type: 'text', text: `${stamp} (replied to your story ${caption}) ${visitorText(r.text)}` }];
  }

  const ephemeral = r.photo_mode !== 'keep';
  if (image) {
    const note = ephemeral
      ? `${stamp} (sent a ${r.photo_mode === 'once' ? 'view-once' : 'replayable'} photo; you can see it only this time)`
      : `${stamp} (sent a photo)`;
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (r.media_mime ?? 'image/jpeg') as ImageMime,
          data: Buffer.from(image).toString('base64'),
        },
      },
      { type: 'text', text: note },
    ];
  }
  const note = ephemeral
    ? `${stamp} (sent a view-once photo that you already viewed)`
    : `${stamp} (sent a photo earlier in the chat; it's no longer attached)`;
  return [{ type: 'text', text: note }];
}

/**
 * What the visitor typed, with anything shaped like our "[m12 · Mon 9:41 PM]" markers defused,
 * so they can't pass off made-up messages as real ones.
 */
export function visitorText(text: string | null): string {
  return (text ?? '').replace(/\[(\s*m\d+\s*·)/g, '($1');
}

function lastUserRow(rows: MessageRow[], beforeIndex: number): MessageRow | null {
  for (let j = beforeIndex - 1; j >= 0; j--) if (rows[j].sender === 'user') return rows[j];
  return null;
}

function assistantJson(group: MessageRow[], prevUser: MessageRow | null, refByKey: Map<string, string>): string {
  const messages: string[] = [];
  let sendPhoto = 'none';
  let mode = 'keep';
  const quoted = group.find((r) => r.reply_to_id != null)?.reply_to_id;
  for (const r of group) {
    if (r.kind === 'photo') {
      sendPhoto = (r.media_key && refByKey.get(r.media_key)) || 'none';
      mode = r.photo_mode ?? 'keep';
    } else if (r.text) {
      messages.push(r.text);
    }
  }
  return JSON.stringify({
    messages,
    reply_to_message: quoted != null ? messageRef(quoted) : 'none',
    heart_latest_user_message: prevUser?.heart_by_ai === 1,
    send_photo: sendPhoto,
    send_photo_mode: mode,
  });
}
