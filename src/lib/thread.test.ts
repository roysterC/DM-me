import { describe, expect, it } from 'vitest';
import type { MessageDTO } from '../../shared/types';
import { bubbleRadius, buildThread, mergeServer } from './thread';
import { separatorLabel, shortAge } from './time';

const msg = (id: number, sender: 'user' | 'ai', at: string, extra: Partial<MessageDTO> = {}): MessageDTO => ({
  id,
  sender,
  kind: 'text',
  text: `m${id}`,
  createdAt: at,
  readAt: null,
  heartByUser: false,
  heartByAi: false,
  photo: null,
  story: null,
  replyTo: null,
  ...extra,
});

describe('buildThread', () => {
  it('groups runs, puts Alisa’s avatar on the last bubble, and adds time breaks after an hour', () => {
    const rows = buildThread(
      [
        msg(1, 'ai', '2026-10-09T20:00:00Z'),
        msg(2, 'ai', '2026-10-09T20:00:05Z'),
        msg(3, 'user', '2026-10-09T20:01:00Z'),
        msg(4, 'user', '2026-10-09T21:30:00Z'),
      ],
      new Date('2026-10-09T22:00:00Z'),
    );
    expect(rows.map((r) => r.type)).toEqual(['separator', 'message', 'message', 'message', 'separator', 'message']);
    const m = rows.filter((r) => r.type === 'message');
    expect(m.map((r) => [r.joinPrev, r.joinNext, r.showAvatar])).toEqual([
      [false, true, false],
      [true, false, true],
      [false, false, false],
      [false, false, false],
    ]);
  });

  it('breaks a run after a bubble with a heart under it', () => {
    const rows = buildThread([
      msg(1, 'ai', '2026-10-09T20:00:00Z', { heartByUser: true }),
      msg(2, 'ai', '2026-10-09T20:00:05Z'),
    ]).filter((r) => r.type === 'message');
    expect(rows[0].joinNext).toBe(false);
    expect(rows[1].joinPrev).toBe(false);
  });
});

describe('labels', () => {
  it('tightens the corners that touch a neighbour', () => {
    expect(bubbleRadius('user', true, true)).toBe('22px 6px 6px 22px');
    expect(bubbleRadius('ai', true, false)).toBe('6px 22px 22px 22px');
  });

  it('formats separators and ages like Instagram', () => {
    const now = new Date(2026, 9, 9, 22, 0);
    expect(separatorLabel(new Date(2026, 9, 9, 21, 2).toISOString(), now)).toBe('Today 9:02 PM');
    expect(separatorLabel(new Date(2026, 9, 8, 8, 10).toISOString(), now)).toBe('Yesterday 8:10 AM');
    expect(shortAge(new Date(now.getTime() - 3 * 3600_000).toISOString(), now.getTime())).toBe('3h');
  });
});

describe('mergeServer', () => {
  it('keeps what the visitor sent since, but not old messages that slid out of the server’s window', () => {
    const at = '2026-10-09T21:00:00.000Z';
    // The server now sends messages 2–4; message 1 (theirs) is older than its window.
    const server = [msg(2, 'ai', at), msg(3, 'user', at), msg(4, 'ai', at)];
    const local = [msg(1, 'user', at), ...server, msg(5, 'user', at), { ...msg(-1, 'user', at), pending: 'sending' as const }];
    expect(mergeServer(server, local).map((m) => m.id)).toEqual([2, 3, 4, 5, -1]);
  });
});
