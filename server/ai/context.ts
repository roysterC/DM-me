import type Anthropic from '@anthropic-ai/sdk';
import type { MessageRow } from '../db';
import type { MediaStore } from '../media';
import { CAMERA_ROLL } from './nova';

type Block = Anthropic.Beta.BetaContentBlockParam;
type Turn = Anthropic.Beta.BetaMessageParam;

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
 * image blocks; Nova's rows become the JSON replies she produced. Returns the
 * ids of view-once photos Nova is seeing for the first (and only) time.
 */
export function buildConversation(
  rows: MessageRow[],
  media: MediaStore,
  timeZone: string,
): { messages: Turn[]; opening: number[] } {
  const opening: number[] = [];

  // Decide which user photos are shown as images, newest first, within the cap.
  const showImage = new Set<number>();
  let images = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.sender !== 'user' || r.kind !== 'photo' || !r.media_file || !media.exists(r.media_file)) continue;
    const ephemeral = r.photo_mode !== 'keep';
    if (ephemeral && r.view_count > 0) continue;
    if (ephemeral) {
      showImage.add(r.id);
      opening.push(r.id);
      images++;
    } else if (images < MAX_IMAGES) {
      showImage.add(r.id);
      images++;
    }
  }

  const turns: Turn[] = [];
  let i = 0;
  while (i < rows.length) {
    const sender = rows[i].sender;
    const group: MessageRow[] = [];
    while (i < rows.length && rows[i].sender === sender) group.push(rows[i++]);

    if (sender === 'user') {
      const blocks: Block[] = [];
      for (const r of group) blocks.push(...userBlocks(r, showImage.has(r.id), media, timeZone));
      turns.push({ role: 'user', content: blocks });
    } else {
      const before = turns.length > 0 ? lastUserRow(rows, rows.indexOf(group[0])) : null;
      turns.push({ role: 'assistant', content: assistantJson(group, before) });
    }
  }

  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(opened the chat)' });
  return { messages: turns, opening };
}

function userBlocks(r: MessageRow, withImage: boolean, media: MediaStore, timeZone: string): Block[] {
  const stamp = `[${formatStamp(r.created_at, timeZone)}]`;
  if (r.kind === 'text') return [{ type: 'text', text: `${stamp} ${r.text ?? ''}` }];

  if (r.kind === 'story_reply') {
    const story = r.story_snapshot ? (JSON.parse(r.story_snapshot) as { caption?: string | null }) : {};
    const caption = story.caption ? `"${story.caption}"` : '(no caption)';
    return [{ type: 'text', text: `${stamp} (replied to your story ${caption}) ${r.text ?? ''}` }];
  }

  // Photo
  const ephemeral = r.photo_mode !== 'keep';
  if (withImage && r.media_file) {
    const data = media.read(r.media_file);
    if (data) {
      const note = ephemeral
        ? `${stamp} (sent a ${r.photo_mode === 'once' ? 'view-once' : 'replayable'} photo; you can see it only this time)`
        : `${stamp} (sent a photo)`;
      return [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: (r.media_mime ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: data.toString('base64'),
          },
        },
        { type: 'text', text: note },
      ];
    }
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

function assistantJson(group: MessageRow[], prevUser: MessageRow | null): string {
  const messages: string[] = [];
  let sendPhoto = 'none';
  let mode = 'keep';
  for (const r of group) {
    if (r.kind === 'photo') {
      sendPhoto = CAMERA_ROLL.find((p) => p.file === r.media_file)?.id ?? 'none';
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
