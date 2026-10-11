/**
 * Human-like reply timing. Alisa's bubbles are stored with the time they should
 * appear, and stay hidden until then: each one takes about as long as typing it
 * on a phone, with some variance, and a short pause between bubbles.
 */

export interface PacingOptions {
  /** Typing speed. 0 sends every bubble at once, as soon as the reply is ready. */
  charsPerSecond: number;
  /** Returns a number in [0, 1); injectable for tests. */
  random?: () => number;
}

/** No single bubble takes longer than this to "type". */
const MAX_TYPING_MS = 20_000;
/** Getting started on a bubble: picking up the phone, thinking of the first word. */
const START_MS = 700;
/** Choosing a photo from the camera roll. */
const PHOTO_MS = [2_000, 4_000] as const;
/** Between one bubble landing and starting on the next. */
const PAUSE_MS = [350, 900] as const;

const between = (r: () => number, [lo, hi]: readonly [number, number]) => lo + r() * (hi - lo);

/** How long one bubble takes to type: proportional to its length, give or take a quarter. */
export function typingMs(text: string, { charsPerSecond, random = Math.random }: PacingOptions): number {
  if (charsPerSecond <= 0) return 0;
  const chars = [...text].length;
  const ms = (START_MS + (chars / charsPerSecond) * 1000) * between(random, [0.8, 1.25]);
  return Math.round(Math.min(ms, MAX_TYPING_MS));
}

export type Bubble = { kind: 'text'; text: string } | { kind: 'photo' };

/**
 * When each bubble should appear (epoch ms). Typing starts when the reply was
 * requested, so the time spent waiting for the model counts towards the first
 * bubble. `notBefore` is when Alisa's previous bubbles finish landing; she starts
 * typing this reply only after a pause from then.
 */
export function schedule(
  bubbles: Bubble[],
  { startedAt, readyAt, notBefore = 0, ...opts }: PacingOptions & { startedAt: number; readyAt: number; notBefore?: number },
): number[] {
  const random = opts.random ?? Math.random;
  if (opts.charsPerSecond <= 0) return bubbles.map(() => Math.max(readyAt, notBefore));
  const times: number[] = [];
  let typingFrom = Math.max(startedAt, notBefore ? notBefore + between(random, PAUSE_MS) : 0);
  for (const b of bubbles) {
    const duration = b.kind === 'photo' ? between(random, PHOTO_MS) : typingMs(b.text, { ...opts, random });
    // Nothing can land before the reply exists, or before the previous bubble.
    const at = Math.max(Math.round(typingFrom + duration), readyAt, (times.at(-1) ?? 0) + 1);
    times.push(at);
    typingFrom = at + between(random, PAUSE_MS);
  }
  return times;
}

const MIN_SPLIT_PIECE = 15;
const SPLIT_LONGER_THAN = 60;
const MAX_BUBBLES = 6;
// After a sentence end or an emoji, before the next word.
const BOUNDARY = /(?<=[.!?…]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|️)\s+(?=[\p{L}"'“‘])/gu;

/**
 * Splits a long one-line bubble into the separate texts a person would send:
 * "lol not a chance 💀 what's got you up this late" becomes two bubbles. Bubbles
 * with line breaks (lists, recipes) and short ones are left alone.
 */
export function splitBubble(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= SPLIT_LONGER_THAN || trimmed.includes('\n')) return [trimmed];
  const pieces: string[] = [];
  let start = 0;
  for (const m of trimmed.matchAll(BOUNDARY)) {
    const piece = trimmed.slice(start, m.index).trim();
    const rest = trimmed.slice(m.index + m[0].length).trim();
    if (piece.length >= MIN_SPLIT_PIECE && rest.length >= MIN_SPLIT_PIECE) {
      pieces.push(piece);
      start = m.index + m[0].length;
    }
  }
  pieces.push(trimmed.slice(start).trim());
  return pieces;
}

/** Splits every bubble that needs it, keeping the reply to a sensible number of bubbles. */
export function splitBubbles(texts: string[]): string[] {
  const out = texts.flatMap(splitBubble).filter(Boolean);
  if (out.length <= MAX_BUBBLES) return out;
  // Too many: fold the extras back into the last bubble rather than flooding the chat.
  return [...out.slice(0, MAX_BUBBLES - 1), out.slice(MAX_BUBBLES - 1).join(' ')];
}
