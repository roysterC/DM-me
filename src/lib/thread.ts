import type { MessageDTO } from '../../shared/types';
import { separatorLabel } from './time';

/** A message on screen, possibly still uploading or failed. */
export type UiMessage = MessageDTO & { pending?: 'sending' | 'failed' };

export type ThreadRow =
  | { type: 'separator'; key: string; label: string }
  | {
      type: 'message';
      key: string;
      message: UiMessage;
      /** Same sender directly above / below, so the touching corners tighten. */
      joinPrev: boolean;
      joinNext: boolean;
      /** Alisa's avatar sits beside the last bubble of each of her runs. */
      showAvatar: boolean;
    };

const GAP_MS = 60 * 60 * 1000;

export function buildThread(messages: UiMessage[], now = new Date()): ThreadRow[] {
  const rows: ThreadRow[] = [];
  const breakBefore = (i: number) =>
    i === 0 || new Date(messages[i].createdAt).getTime() - new Date(messages[i - 1].createdAt).getTime() > GAP_MS;

  messages.forEach((m, i) => {
    if (breakBefore(i)) rows.push({ type: 'separator', key: `sep-${m.id}`, label: separatorLabel(m.createdAt, now) });
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const joinPrev = !!prev && prev.sender === m.sender && !breakBefore(i) && !hasReaction(prev);
    const joinNext = !!next && next.sender === m.sender && !breakBefore(i + 1) && !hasReaction(m);
    rows.push({
      type: 'message',
      key: `m-${m.id}`,
      message: m,
      joinPrev,
      joinNext,
      showAvatar: m.sender === 'ai' && !joinNext,
    });
  });
  return rows;
}

/** A heart under a bubble separates it from the next one, as on Instagram. */
function hasReaction(m: UiMessage) {
  return m.sender === 'ai' ? m.heartByUser : m.heartByAi;
}

/** Corner radii for a bubble: 22px outside a run, 6px where it touches a neighbour. */
export function bubbleRadius(sender: 'user' | 'ai', joinPrev: boolean, joinNext: boolean): string {
  const R = '22px';
  const r = '6px';
  return sender === 'user'
    ? `${R} ${joinPrev ? r : R} ${joinNext ? r : R} ${R}`
    : `${joinPrev ? r : R} ${R} ${R} ${joinNext ? r : R}`;
}
