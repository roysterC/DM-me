import type Anthropic from '@anthropic-ai/sdk';
import type { MessageRow } from '../db';
import type { MediaStore } from '../media';

type Block = Anthropic.ContentBlockParam;
type Turn = Anthropic.MessageParam;
type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const MAX_IMAGES = 12;

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
): Promise<{ messages: Turn[]; opening: number[] }> {
  const opening: number[] = [];

  // Decide which user photos are shown as images, newest first, within the cap.
  const images = new Map<number, Uint8Array>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.sender !== 'user' || r.kind !== 'photo' || !r.media_key) continue;
    const ephemeral = r.photo_mode !== 'keep';
    if (ephemeral && r.view_count > 0) continue;
    if (!ephemeral && images.size >= MAX_IMAGES) continue;
    const data = await media.read(r.media_key);
    if (!data) continue;
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
      for (const r of group) blocks.push(...userBlocks(r, images.get(r.id), timeZone));
      turns.push({ role: 'user', content: blocks });
    } else {
      turns.push({ role: 'assistant', content: assistantJson(group, lastUserRow(rows, start), refByKey) });
    }
  }

  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(opened the chat)' });
  return { messages: turns, opening };
}

function userBlocks(r: MessageRow, image: Uint8Array | undefined, timeZone: string): Block[] {
  const stamp = `[${formatStamp(r.created_at, timeZone)}]`;
  if (r.kind === 'text') return [{ type: 'text', text: `${stamp} ${r.text ?? ''}` }];

  if (r.kind === 'story_reply') {
    const story = r.story_snapshot ? (JSON.parse(r.story_snapshot) as { caption?: string | null }) : {};
    const caption = story.caption ? `"${story.caption}"` : '(no caption)';
    return [{ type: 'text', text: `${stamp} (replied to your story ${caption}) ${r.text ?? ''}` }];
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

function lastUserRow(rows: MessageRow[], beforeIndex: number): MessageRow | null {
  for (let j = beforeIndex - 1; j >= 0; j--) if (rows[j].sender === 'user') return rows[j];
  return null;
}

function assistantJson(group: MessageRow[], prevUser: MessageRow | null, refByKey: Map<string, string>): string {
  const messages: string[] = [];
  let sendPhoto = 'none';
  let mode = 'keep';
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
    heart_latest_user_message: prevUser?.heart_by_ai === 1,
    send_photo: sendPhoto,
    send_photo_mode: mode,
  });
}
