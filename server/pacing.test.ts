import { describe, expect, it } from 'vitest';
import { schedule, splitBubble, splitBubbles, typingMs } from './pacing';

const fixed = (v: number) => () => v;

describe('typingMs', () => {
  it('grows with the length of the text, within a quarter either way', () => {
    const short = typingMs('lol same', { charsPerSecond: 7, random: fixed(0.5) });
    const long = typingMs('ok so i think the move is pasta tonight and a long walk tomorrow', { charsPerSecond: 7, random: fixed(0.5) });
    expect(long).toBeGreaterThan(short * 3);
    const slow = typingMs('hello there friend', { charsPerSecond: 7, random: fixed(0.999) });
    const fast = typingMs('hello there friend', { charsPerSecond: 7, random: fixed(0) });
    expect(slow / fast).toBeCloseTo(1.25 / 0.8, 1);
    expect(typingMs('x'.repeat(5000), { charsPerSecond: 7 })).toBe(20_000);
    expect(typingMs('anything', { charsPerSecond: 0 })).toBe(0);
  });
});

describe('schedule', () => {
  const bubbles = [
    { kind: 'text' as const, text: 'omg wait' },
    { kind: 'text' as const, text: 'that is actually so cute what did they say after' },
    { kind: 'photo' as const },
  ];

  it('counts the time spent thinking towards the first bubble and spaces the rest', () => {
    const times = schedule(bubbles, { charsPerSecond: 7, startedAt: 0, readyAt: 1500, random: fixed(0.5) });
    expect(times[0]).toBeGreaterThan(1500);
    expect(times[0]).toBeLessThan(3500);
    expect(times[1] - times[0]).toBeGreaterThan(5000);
    expect(times[2] - times[1]).toBeGreaterThan(2000);
  });

  it('never sends before the reply is ready or before earlier bubbles', () => {
    const slowModel = schedule(bubbles, { charsPerSecond: 7, startedAt: 0, readyAt: 30_000, random: fixed(0.5) });
    expect(slowModel[0]).toBe(30_000);
    const queued = schedule(bubbles, { charsPerSecond: 7, startedAt: 0, readyAt: 100, notBefore: 60_000, random: fixed(0.5) });
    expect(queued[0]).toBeGreaterThan(60_000);
  });

  it('sends everything at once when timing is off', () => {
    expect(schedule(bubbles, { charsPerSecond: 0, startedAt: 0, readyAt: 500 })).toEqual([500, 500, 500]);
  });
});

describe('splitBubble', () => {
  it('splits a reaction from the question that follows it', () => {
    expect(splitBubble('lol the freaky energy is not going to get a yes from me 💀 what’s got you up this late though')).toEqual([
      'lol the freaky energy is not going to get a yes from me 💀',
      'what’s got you up this late though',
    ]);
    expect(splitBubble('ok that is genuinely the best news i have heard all week. how are you celebrating tonight?')).toEqual([
      'ok that is genuinely the best news i have heard all week.',
      'how are you celebrating tonight?',
    ]);
    expect(splitBubble('wait no that’s so sweet ❤️ did they actually remember your birthday this time')).toEqual([
      'wait no that’s so sweet ❤️',
      'did they actually remember your birthday this time',
    ]);
  });

  it('leaves short bubbles, lists and tiny fragments alone', () => {
    expect(splitBubble('lmao 😭 stop')).toEqual(['lmao 😭 stop']);
    const recipe = 'ok easy one:\n1. boil pasta\n2. garlic in butter. then parmesan\n3. eat it in bed';
    expect(splitBubble(recipe)).toEqual([recipe]);
    expect(splitBubble('ok. i need you to tell me everything that happened at the party last night')).toEqual([
      'ok. i need you to tell me everything that happened at the party last night',
    ]);
  });

  it('keeps a reply to a handful of bubbles', () => {
    const many = Array.from({ length: 9 }, (_, i) => `bubble ${i}`);
    const out = splitBubbles(many);
    expect(out).toHaveLength(6);
    expect(out.at(-1)).toBe('bubble 5 bubble 6 bubble 7 bubble 8');
  });
});
