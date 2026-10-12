import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ChatDTO, LibraryPhotoDTO, MessageDTO, OpenPhotoDTO, StoryDTO } from '../shared/types';
import { buildConversation, visitorText } from './ai/context';
import { FakeResponder, parseReply, parseStories } from './ai/responder';
import { createApp } from './app';
import { pruneStories, pruneVisitors } from './cleanup';
import { postDailyStories } from './stories';
import { loadConfig } from './config';
import { type MessageRow, openDb } from './db';
import { clientInfo, ProxyTrust } from './identity';
import type { PushSend } from './push';
import { S3Storage } from './storage';

const JPEG = new Uint8Array(fs.readFileSync(path.resolve('server/assets/skillet.jpg')));

function setup(
  opts: {
    connected?: boolean;
    adminPassword?: string;
    dailyReplyLimit?: number;
    dailyBudgetUsd?: number;
    typing?: number;
    clientDir?: string;
  } = {},
) {
  const config = loadConfig({
    dataDir: ':memory:',
    secret: 'test-secret',
    s3: null,
    fakeAi: false,
    adminPassword: opts.adminPassword ?? '',
    autoStories: true,
    seedSamplePhotos: true,
    dailyReplyLimit: opts.dailyReplyLimit ?? 200,
    dailyBudgetUsd: opts.dailyBudgetUsd ?? 2,
    // Replies appear instantly unless a test is about their timing.
    typingCharsPerSecond: opts.typing ?? 0,
    ...(opts.clientDir ? { clientDir: opts.clientDir } : {}),
  });
  const db = openDb(':memory:');
  const fake = new FakeResponder();
  // Notifications are recorded instead of sent; one goes out 300 ms after its bubble is due.
  const pushes: { endpoint: string; payload: { title: string; body: string }; subject: string }[] = [];
  const pushFails = new Map<string, number>();
  const send: PushSend = async (sub, payload, _keys, subject) => {
    const status = pushFails.get(sub.endpoint);
    if (status) throw Object.assign(new Error('push failed'), { statusCode: status });
    pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), subject });
  };
  const { app, deps } = createApp(db, config, opts.connected === false ? null : fake, undefined, { send, graceMs: 300 });

  /** A browser: keeps its own cookies between requests. */
  const browser = () => {
    const jar = new Map<string, string>();
    return async (method: string, url: string, body?: unknown) => {
      const headers: Record<string, string> = { origin: 'http://localhost', host: 'localhost' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload: BodyInit | undefined;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await app.request(url.startsWith('http') ? url : `http://localhost${url}`, { method, headers, body: payload });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (v) jar.set(k, v);
        else jar.delete(k);
      }
      return res;
    };
  };

  const photoForm = (mode: string) => {
    const form = new FormData();
    form.set('photo', new File([JPEG], 'p.jpg', { type: 'image/jpeg' }));
    form.set('mode', mode);
    return form;
  };

  return { app, db, deps, fake, browser, photoForm, pushes, pushFails };
}

const json = async <T>(res: Response) => (await res.json()) as T;

describe('health check', () => {
  it('identifies itself as DM-me', async () => {
    const t = setup();
    expect(await json(await t.app.request('http://localhost/api/health'))).toEqual({ app: 'dm-me', ok: true });
  });

  it('fails in production when the built web app is missing, so a deploy rolls back', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const t = setup({ clientDir: '/nonexistent/dm-me-client' });
      const res = await t.app.request('http://localhost/api/health');
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ app: 'dm-me', ok: false, problems: ['web app files'] });
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('visitors', () => {
  it('gives each browser its own chat without any sign-up', async () => {
    const t = setup();
    const maya = t.browser();
    const sam = t.browser();
    const first = await json<ChatDTO>(await maya('GET', '/api/chat'));
    // Alisa doesn't text first.
    expect(first.messages).toHaveLength(0);

    await maya('POST', '/api/chat/messages', { text: 'just for me' });
    const samChat = await json<ChatDTO>(await sam('GET', '/api/chat'));
    expect(samChat.messages.some((m) => m.text === 'just for me')).toBe(false);
    const mayaChat = await json<ChatDTO>(await maya('GET', '/api/chat'));
    expect(mayaChat.messages.at(-1)?.text).toBe('just for me');
  });

  it('blocks cross-site writes', async () => {
    const t = setup();
    const res = await t.app.request('http://localhost/api/chat/messages', {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('deletes a conversation and the photos uploaded to it', async () => {
    const t = setup();
    const me = t.browser();
    const sent = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/photos', t.photoForm('keep')))).message;
    const key = (t.db.prepare('SELECT media_key FROM messages WHERE id = ?').get(sent.id) as MessageRow).media_key!;
    expect(await t.deps.media.storage.get(key)).not.toBeNull();
    const after = await json<ChatDTO>(await me('DELETE', '/api/chat'));
    expect(after.messages).toHaveLength(0);
    expect(await t.deps.media.storage.get(key)).toBeNull();
  });
});

describe('chat', () => {
  it('replies to a burst of messages at once and marks them seen', async () => {
    const t = setup();
    const me = t.browser();
    await me('GET', '/api/chat');
    await me('POST', '/api/chat/messages', { text: 'ok be honest' });
    await me('POST', '/api/chat/messages', { text: 'is it weird' });
    const after = await json<ChatDTO>(await me('POST', '/api/chat/reply', { timeZone: 'America/New_York' }));

    expect(t.fake.calls).toHaveLength(1);
    const sent = t.fake.calls[0].messages;
    // The visitor opens the conversation; both texts arrive together as one turn.
    expect(sent.map((m) => m.role)).toEqual(['user']);
    expect(JSON.stringify(sent[0].content)).toMatch(/ok be honest.*is it weird/);
    expect(t.fake.calls[0].system).toContain('p1: a baked egg skillet');
    expect(after.messages.at(-1)).toMatchObject({ sender: 'ai', text: 'You said: ok be honest is it weird' });
    expect(after.messages.filter((m) => m.sender === 'user').every((m) => m.readAt)).toBe(true);

    await me('POST', '/api/chat/reply', {});
    expect(t.fake.calls).toHaveLength(1);
  });

  it('says so when Alisa is not connected', async () => {
    const t = setup({ connected: false });
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hi' });
    expect((await me('POST', '/api/chat/reply', {})).status).toBe(503);
    expect((await json<ChatDTO>(await me('GET', '/api/chat'))).aiConnected).toBe(false);
  });

  it('caps replies per visitor per day', async () => {
    const t = setup({ dailyReplyLimit: 1 });
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'one' });
    expect((await me('POST', '/api/chat/reply', {})).status).toBe(200);
    await me('POST', '/api/chat/messages', { text: 'two' });
    expect((await me('POST', '/api/chat/reply', {})).status).toBe(429);
  });

  it('stops replying to everyone once the day’s Claude budget is spent', async () => {
    const t = setup({ dailyBudgetUsd: 0.5, adminPassword: 'open sesame' });
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'one' });
    expect((await me('POST', '/api/chat/reply', {})).status).toBe(200);

    // A million output tokens on Haiku 5.5 is $0.50, the whole budget.
    t.deps.budget.record('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 });
    const other = t.browser();
    await other('POST', '/api/chat/messages', { text: 'hello?' });
    const res = await other('POST', '/api/chat/reply', {});
    expect(res.status).toBe(429);
    expect((await json<{ error: string }>(res)).error).toMatch(/done chatting for today/);
    expect(t.fake.calls).toHaveLength(1);

    const admin = t.browser();
    expect((await json<{ spend?: unknown }>(await admin('GET', '/api/admin/me'))).spend).toBeUndefined();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    const { spend } = await json<{ spend: { calls: number; spentUsd: number; limitUsd: number } }>(
      await admin('GET', '/api/admin/me'),
    );
    expect(spend).toMatchObject({ calls: 1, spentUsd: 0.5, limitUsd: 0.5 });
  });

  it('has no site-wide limit when the budget is 0', async () => {
    const t = setup({ dailyBudgetUsd: 0 });
    t.deps.budget.record('claude-haiku-5-5', { input_tokens: 0, output_tokens: 100_000_000 });
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hi' });
    expect((await me('POST', '/api/chat/reply', {})).status).toBe(200);
  });

  it('lets the visitor heart Alisa’s messages, and Alisa heart theirs', async () => {
    const t = setup();
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hey' });
    const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    const reply = chat.messages.find((m) => m.sender === 'ai')!;
    const res = await me('POST', `/api/chat/messages/${reply.id}/heart`, { on: true });
    expect((await json<{ message: MessageDTO }>(res)).message.heartByUser).toBe(true);

    await me('POST', '/api/chat/messages', { text: 'got the job! heart this' });
    const after = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    expect(after.messages.find((m) => m.text === 'got the job! heart this')?.heartByAi).toBe(true);
  });
});

describe('double texting', () => {
  it('answers a message sent while Alisa is still thinking, after what she was saying', async () => {
    const t = setup();
    // Hold Alisa's first reply until the second message is in.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reply = t.fake.reply.bind(t.fake);
    let held = false;
    t.fake.reply = async (req) => {
      if (!held) {
        held = true;
        await gate;
      }
      return reply(req);
    };
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hey' });
    const thinking = me('POST', '/api/chat/reply', {});
    await new Promise((r) => setTimeout(r, 20));
    await me('POST', '/api/chat/messages', { text: 'u there?' });
    release();
    await thinking;

    const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    // She wrote her first answer before reading "u there?", so that's how her history reads,
    // and it ends with the message she still owes a reply to.
    const second = t.fake.calls[1].messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(second.at(-1))).toContain('u there?');
    expect(chat.messages.at(-1)).toMatchObject({ sender: 'ai', text: 'You said: u there?' });
    // Nothing left owed.
    await me('POST', '/api/chat/reply', {});
    expect(t.fake.calls).toHaveLength(2);
  });

  it('retries after a failed reply instead of treating the message as answered', async () => {
    const t = setup();
    const reply = t.fake.reply.bind(t.fake);
    t.fake.reply = async () => {
      throw new Error('Claude is down');
    };
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hello?' });
    expect((await me('POST', '/api/chat/reply', {})).status).toBe(502);
    t.fake.reply = reply;
    const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    expect(chat.messages.at(-1)).toMatchObject({ sender: 'ai', text: 'You said: hello?' });
  });
});

describe('quote-replies', () => {
  it('lets the visitor reply to a message, shows the quote, and tells Alisa what was quoted', async () => {
    const t = setup();
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'how was the exam' });
    const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    const hers = chat.messages.find((m) => m.sender === 'ai')!;

    const sent = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/messages', { text: 'wait what', replyTo: hers.id }))).message;
    expect(sent.replyTo).toEqual({ id: hers.id, sender: 'ai', text: hers.text, photo: false });
    const photo = t.photoForm('keep');
    photo.set('replyTo', String(sent.id));
    const pic = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/photos', photo))).message;
    expect(pic.replyTo).toMatchObject({ id: sent.id, sender: 'user', text: 'wait what' });

    await me('POST', '/api/chat/reply', {});
    const lastTurn = JSON.stringify(t.fake.calls.at(-1)!.messages.at(-1));
    expect(lastTurn).toContain(`(replying to your message: \\"${hers.text}\\") wait what`);
    expect(lastTurn).toContain('(replying to their own message: \\"wait what\\")');
    // The quote survives a reload.
    const reloaded = await json<ChatDTO>(await me('GET', '/api/chat'));
    expect(reloaded.messages.find((m) => m.id === sent.id)?.replyTo?.id).toBe(hers.id);
  });

  it('ignores quotes of messages from someone else’s chat, or not showing yet', async () => {
    const t = setup({ typing: 7 });
    const other = t.browser();
    const mine = (await json<{ message: MessageDTO }>(await other('POST', '/api/chat/messages', { text: 'private' }))).message;
    const me = t.browser();
    const sent = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/messages', { text: 'hi', replyTo: mine.id }))).message;
    expect(sent.replyTo).toBeNull();

    // Alisa's bubble is still being "typed": it can't be quoted until it shows.
    await me('POST', '/api/chat/reply', {});
    const due = t.db.prepare("SELECT id FROM messages WHERE sender = 'ai'").get() as { id: number };
    const early = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/messages', { text: 'hm', replyTo: due.id }))).message;
    expect(early.replyTo).toBeNull();
  });

  it('lets Alisa quote one of the visitor’s messages, and only theirs', async () => {
    const t = setup();
    const me = t.browser();
    const first = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/messages', { text: 'did u see the game' }))).message;
    await me('POST', '/api/chat/messages', { text: 'also quote me' });
    const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    const hers = chat.messages.filter((m) => m.sender === 'ai');
    expect(hers[0].replyTo).toMatchObject({ id: first.id, sender: 'user', text: 'did u see the game' });
    expect(hers.slice(1).every((m) => m.replyTo === null)).toBe(true);
    // Her past quotes come back to her in her own format.
    await me('POST', '/api/chat/messages', { text: 'lol' });
    await me('POST', '/api/chat/reply', {});
    const assistantTurn = t.fake.calls.at(-1)!.messages.find((m) => m.role === 'assistant')!;
    expect(JSON.parse(assistantTurn.content as string).reply_to_message).toBe(`m${first.id}`);
  });
});

describe('reply timing', () => {
  it('holds Alisa’s bubbles back until she’d have typed them, in order', async () => {
    const t = setup({ typing: 7 });
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'u up?' });
    const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    // "You said: u up?" is about 15 characters: roughly 2-4 seconds to type.
    expect(chat.messages.filter((m) => m.sender === 'ai')).toHaveLength(0);
    expect(chat.upcoming).toHaveLength(1);
    expect(chat.upcoming[0]).toBeGreaterThan(1000);
    expect(chat.upcoming[0]).toBeLessThan(5000);

    // A message sent while she's typing lands before her bubble.
    await me('POST', '/api/chat/messages', { text: 'hello??' });
    const rows = t.db.prepare('SELECT sender, text, created_at FROM messages ORDER BY created_at, id').all() as MessageRow[];
    expect(rows.map((r) => r.text)).toEqual(['u up?', 'hello??', 'You said: u up?']);

    // Her reply to it is queued after the first one, never interleaved with it. She wrote her
    // first bubble before reading "hello??", so that's how the model sees it.
    const next = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    expect(t.fake.calls[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(next.upcoming).toHaveLength(2);
    expect(next.upcoming[1]).toBeGreaterThan(next.upcoming[0]);
  });
});

describe('photos', () => {
  it('shows kept photos to Alisa and serves them through signed links', async () => {
    const t = setup();
    const me = t.browser();
    const photo = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/photos', t.photoForm('keep')))).message;
    expect(photo.photo).toMatchObject({ mode: 'keep', width: 800, height: 666 });
    const url = photo.photo!.url!;
    expect(url).toMatch(/^\/api\/media\/f\?k=uploads/);

    await me('POST', '/api/chat/reply', {});
    const lastTurn = t.fake.calls[0].messages.at(-1)!;
    expect(Array.isArray(lastTurn.content) && lastTurn.content.some((b) => b.type === 'image')).toBe(true);

    expect((await t.app.request(`http://localhost${url}`)).status).toBe(200);
    expect((await t.app.request(`http://localhost${url.replace(/s=[^&]+/, 's=forged')}`)).status).toBe(410);
  });

  it('lets Alisa see a view-once photo exactly once, then deletes it', async () => {
    const t = setup();
    const me = t.browser();
    const sent = (await json<{ message: MessageDTO }>(await me('POST', '/api/chat/photos', t.photoForm('once')))).message;
    expect(sent.photo).toMatchObject({ mode: 'once', url: null, viewCount: 0, maxViews: 1 });
    const key = (t.db.prepare('SELECT media_key FROM messages WHERE id = ?').get(sent.id) as MessageRow).media_key!;

    const after = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    expect(after.messages.find((m) => m.id === sent.id)?.photo?.viewCount).toBe(1);
    expect(await t.deps.media.storage.get(key)).toBeNull();

    await me('POST', '/api/chat/messages', { text: 'did you like it' });
    await me('POST', '/api/chat/reply', {});
    const second = JSON.stringify(t.fake.calls[1].messages);
    expect(second).not.toContain('"type":"image"');
    // All she has left of it is the note she made when she saw it, in her reply and in its place.
    expect(second).toContain('view-once photo that you already viewed; you remember it showed: a golden-edged skillet');
    expect(JSON.parse(t.fake.calls[1].messages[1].content as string).remember_photo).toBe('a golden-edged skillet');
  });

  it('reads the photo note from Alisa’s reply, and only keeps a real one', () => {
    const base = { messages: ['ok'], reply_to_message: 'none', heart_latest_user_message: false, send_photo: 'none', send_photo_mode: 'keep' };
    expect(parseReply(JSON.stringify({ ...base, remember_photo: '  their cat on a sofa ' }), []).photoMemory).toBe('their cat on a sofa');
    expect(parseReply(JSON.stringify({ ...base, remember_photo: '' }), []).photoMemory).toBeNull();
    expect(parseReply(JSON.stringify(base), []).photoMemory).toBeNull();
  });

  it('limits opens of photos Alisa sends: once means once, replay means twice', async () => {
    const t = setup();
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'send me a photo' });
    let chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    const once = chat.messages.find((m) => m.sender === 'ai' && m.kind === 'photo')!;
    expect(once.photo).toMatchObject({ mode: 'once', url: null });

    const opened = await json<OpenPhotoDTO>(await me('POST', `/api/chat/messages/${once.id}/open`));
    expect(opened).toMatchObject({ viewCount: 1, maxViews: 1, seconds: 5 });
    expect((await t.app.request(`http://localhost${opened.url}`)).headers.get('cache-control')).toBe('no-store');
    expect((await me('POST', `/api/chat/messages/${once.id}/open`)).status).toBe(410);

    await me('POST', '/api/chat/messages', { text: 'another photo, replay ok' });
    chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    const replay = chat.messages.filter((m) => m.kind === 'photo' && m.sender === 'ai').at(-1)!;
    expect(replay.photo?.mode).toBe('replay');
    expect((await me('POST', `/api/chat/messages/${replay.id}/open`)).status).toBe(200);
    expect((await me('POST', `/api/chat/messages/${replay.id}/open`)).status).toBe(200);
    expect((await me('POST', `/api/chat/messages/${replay.id}/open`)).status).toBe(410);
  });

  it('sends a camera-roll photo the way the admin page says, whatever Alisa picks', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const admin = t.browser();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    const me = t.browser();
    const photoFromAlisa = async (text: string) => {
      await me('POST', '/api/chat/messages', { text });
      const chat = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
      return chat.messages.filter((m) => m.sender === 'ai' && m.kind === 'photo').at(-1)!;
    };

    // The fake Alisa sends the first photo in her roll as view-once.
    expect((await photoFromAlisa('send me a photo')).photo?.mode).toBe('once');
    const id = Number(t.fake.calls[0].photoRefs[0].slice(1));
    const photos = (await json<{ photos: LibraryPhotoDTO[] }>(await admin('GET', '/api/admin/photos'))).photos;
    expect(photos.find((p) => p.id === id)?.sendMode).toBe('auto');

    expect((await admin('PATCH', `/api/admin/photos/${id}`, { sendMode: 'forever' })).status).toBe(400);
    expect((await admin('PATCH', `/api/admin/photos/${id}`, { sendMode: 'keep' })).status).toBe(200);
    const kept = await photoFromAlisa('send me a photo');
    expect(kept.photo).toMatchObject({ mode: 'keep', maxViews: null });
    expect(kept.photo?.url).toBeTruthy();

    await admin('PATCH', `/api/admin/photos/${id}`, { sendMode: 'replay' });
    expect((await photoFromAlisa('send me a photo')).photo).toMatchObject({ mode: 'replay', url: null, maxViews: 2 });
    // Alisa is told, so her messages can match how the photo arrives.
    expect(t.fake.calls.at(-1)!.system).toContain(`p${id} (always sent as replayable)`);

    // Changing the mode leaves the description alone.
    const after = (await json<{ photos: LibraryPhotoDTO[] }>(await admin('GET', '/api/admin/photos'))).photos;
    expect(after.find((p) => p.id === id)).toMatchObject({ sendMode: 'replay', description: photos.find((p) => p.id === id)!.description });
  });

  it('refuses files that are not images', async () => {
    const t = setup();
    const me = t.browser();
    const form = new FormData();
    form.set('photo', new File(['<script>alert(1)</script>'], 'x.jpg', { type: 'image/jpeg' }));
    expect((await me('POST', '/api/chat/photos', form)).status).toBe(400);
  });
});

describe('stories', () => {
  it('has Alisa write a new set of stories about an hour before the live ones run out', async () => {
    const t = setup();
    // The sample stories were just posted: nothing to do yet.
    expect(await postDailyStories(t.db, t.fake)).toBe(0);
    const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
    t.db.prepare('UPDATE stories SET expires_at = ?').run(inMinutes(50));
    expect(await postDailyStories(t.db, t.fake)).toBe(2);
    expect(t.fake.storyPrompts[0]).toContain('Weekend idea: one long walk, no phone');
    expect(t.fake.storyPrompts[0]).toMatch(/- p\d+: a baked egg skillet/);

    const live = (await json<{ stories: StoryDTO[] }>(await t.browser()('GET', '/api/stories'))).stories;
    const photo = live.find((s) => s.caption === 'made this again bc i have no self control 😭');
    expect(photo).toMatchObject({ kind: 'photo' });
    expect(photo?.mediaUrl).toBeTruthy();
    expect(live.find((s) => s.caption === 'sunday reset or sunday rot. pick one')).toMatchObject({ kind: 'text', bg: 'sunset' });
    // Then not again until those are close to running out.
    expect(await postDailyStories(t.db, t.fake)).toBe(0);
  });

  it('posts nothing when Claude can’t write them (the samples fill in once none are live)', async () => {
    const t = setup();
    t.db.prepare('UPDATE stories SET expires_at = ?').run(new Date(Date.now() - 60_000).toISOString());
    t.fake.writeStories = async () => {
      throw new Error('budget spent');
    };
    expect(await postDailyStories(t.db, t.fake)).toBe(0);
    expect((await json<{ stories: StoryDTO[] }>(await t.browser()('GET', '/api/stories'))).stories).toHaveLength(4);
  });

  it('keeps only real stories from Claude’s answer', () => {
    const raw = JSON.stringify({
      stories: [
        { photo: 'p1', caption: ' look ', background: 'ocean' },
        { photo: 'p99', caption: 'made-up photo becomes text', background: 'nope' },
        { photo: 'none', caption: '', background: 'forest' },
        { photo: 'none', caption: 'four', background: 'forest' },
        { photo: 'none', caption: 'five', background: 'forest' },
      ],
    });
    expect(parseStories(raw, ['p1'])).toEqual([
      { photoRef: 'p1', caption: 'look', bg: 'ocean' },
      { photoRef: null, caption: 'made-up photo becomes text', bg: 'violet' },
      { photoRef: null, caption: 'four', bg: 'forest' },
    ]);
  });

  it('counts story replies toward the same sending limit as other messages', async () => {
    const t = setup();
    const me = t.browser();
    const [story] = (await json<{ stories: StoryDTO[] }>(await me('GET', '/api/stories'))).stories;
    for (let i = 0; i < 30; i++) await me('POST', '/api/chat/messages', { text: `msg ${i}` });
    for (let i = 0; i < 30; i++) {
      expect((await me('POST', `/api/stories/${story.id}/reply`, { text: `reply ${i}` })).status).toBe(200);
    }
    const over = await me('POST', `/api/stories/${story.id}/reply`, { text: 'one more' });
    expect(over.status).toBe(429);
    expect((await me('POST', '/api/chat/messages', { text: 'and a text' })).status).toBe(429);

    // Each visitor has their own allowance.
    const other = t.browser();
    expect((await other('POST', `/api/stories/${story.id}/reply`, { text: 'hi' })).status).toBe(200);
    expect((await other('POST', `/api/stories/${story.id}/reply`, { text: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('posts sample stories, tracks views and likes, and turns replies into DMs', async () => {
    const t = setup();
    const me = t.browser();
    let stories = (await json<{ stories: StoryDTO[] }>(await me('GET', '/api/stories'))).stories;
    expect(stories).toHaveLength(4);
    expect(stories.every((s) => !s.seen)).toBe(true);

    await me('POST', `/api/stories/${stories[0].id}/view`);
    await me('POST', `/api/stories/${stories[0].id}/like`, { on: true });
    stories = (await json<{ stories: StoryDTO[] }>(await me('GET', '/api/stories'))).stories;
    expect(stories[0]).toMatchObject({ seen: true, liked: true });
    expect(stories[1].seen).toBe(false);
    expect((await t.app.request(`http://localhost${stories[0].mediaUrl}`)).headers.get('content-type')).toBe('image/jpeg');

    const reply = await me('POST', `/api/stories/${stories[1].id}/reply`, { text: 'dinner' });
    const msg = (await json<{ message: MessageDTO }>(reply)).message;
    expect(msg).toMatchObject({ kind: 'story_reply', text: 'dinner', story: { available: true, kind: 'text' } });

    await me('POST', '/api/chat/reply', {});
    expect(JSON.stringify(t.fake.calls[0].messages)).toContain('replied to your story \\"3 dinners under 15 minutes');
  });
});

describe('admin', () => {
  it('signs every browser out when ADMIN_PASSWORD changes', async () => {
    const login = await setup({ adminPassword: 'open sesame' }).browser()('POST', '/api/admin/login', { password: 'open sesame' });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const signedIn = async (password: string) => {
      // A restarted server with this password (the secret stays the same).
      const res = await setup({ adminPassword: password }).app.request('http://localhost/api/admin/me', { headers: { cookie } });
      return (await json<{ admin: boolean }>(res)).admin;
    };
    expect(await signedIn('open sesame')).toBe(true);
    expect(await signedIn('a new password')).toBe(false);
  });

  it('stays locked without ADMIN_PASSWORD and with a wrong one', async () => {
    const off = setup();
    expect((await off.browser()('POST', '/api/admin/login', { password: '' })).status).toBe(403);

    const t = setup({ adminPassword: 'open sesame' });
    const guest = t.browser();
    expect((await guest('GET', '/api/admin/photos')).status).toBe(403);
    expect((await guest('POST', '/api/admin/login', { password: 'nope' })).status).toBe(401);
    expect(await json<{ admin: boolean }>(await guest('GET', '/api/admin/me'))).toMatchObject({ enabled: true, admin: false });
  });

  it('posts and deletes stories', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const admin = t.browser();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    const f = new FormData();
    f.set('kind', 'text');
    f.set('caption', 'New drop');
    f.set('bg', 'ocean');
    const story = (await json<{ story: StoryDTO }>(await admin('POST', '/api/admin/stories', f))).story;
    expect(story).toMatchObject({ kind: 'text', caption: 'New drop', bg: 'ocean' });

    const visitor = t.browser();
    let live = (await json<{ stories: StoryDTO[] }>(await visitor('GET', '/api/stories'))).stories;
    expect(live.at(-1)?.caption).toBe('New drop');
    await admin('DELETE', `/api/admin/stories/${story.id}`);
    live = (await json<{ stories: StoryDTO[] }>(await visitor('GET', '/api/stories'))).stories;
    expect(live.some((s) => s.id === story.id)).toBe(false);
  });

  it('manages Alisa’s camera roll: upload, describe, edit, delete and sync from the bucket', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const admin = t.browser();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    const list = async () => (await json<{ photos: LibraryPhotoDTO[] }>(await admin('GET', '/api/admin/photos'))).photos;
    expect((await list()).map((p) => p.sample)).toEqual([true, true, true, true]);

    const one = new FormData();
    one.set('photo', new File([JPEG], 'a.jpg'));
    one.set('description', 'my own skillet');
    const [mine] = (await json<{ photos: LibraryPhotoDTO[] }>(await admin('POST', '/api/admin/photos', one))).photos;
    expect(mine).toMatchObject({ description: 'my own skillet', sample: false, width: 800 });

    const two = new FormData();
    two.set('photo', new File([JPEG], 'b.jpg'));
    const [described] = (await json<{ photos: LibraryPhotoDTO[] }>(await admin('POST', '/api/admin/photos', two))).photos;
    expect(described.description).toBe('a test photo');

    await admin('PATCH', `/api/admin/photos/${described.id}`, { description: 'cast iron, close up' });
    await admin('DELETE', `/api/admin/photos/${mine.id}`);
    const sampleId = (await list()).find((p) => p.sample)!.id;
    await admin('DELETE', `/api/admin/photos/${sampleId}`);
    let photos = await list();
    expect(photos.find((p) => p.id === described.id)?.description).toBe('cast iron, close up');
    expect(photos.some((p) => p.id === mine.id || p.id === sampleId)).toBe(false);

    // A photo dropped straight into the bucket's library/ folder.
    await t.deps.media.storage.put('library/Beach day.jpg', JPEG, 'image/jpeg');
    const sync = await json<{ added: number }>(await admin('POST', '/api/admin/photos/sync'));
    expect(sync.added).toBe(1);
    expect((await json<{ added: number }>(await admin('POST', '/api/admin/photos/sync'))).added).toBe(0);
    photos = await list();
    expect(photos[0].description).toBe('a test photo');

    // Alisa is offered exactly the visible camera roll.
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hi' });
    await me('POST', '/api/chat/reply', {});
    expect(t.fake.calls[0].photoRefs.sort()).toEqual(photos.map((p) => `p${p.id}`).sort());
  });
});

describe('request size limits', () => {
  /** The test JPEG padded with zeros to `bytes`; still a valid photo as far as the server can tell. */
  const padded = (bytes: number) => {
    const data = new Uint8Array(bytes);
    data.set(JPEG);
    return new File([data], 'big.jpg', { type: 'image/jpeg' });
  };
  const MB = 1024 * 1024;

  it('takes only small bodies on routes that expect JSON', async () => {
    const me = setup().browser();
    const res = await me('POST', '/api/chat/messages', { text: 'x'.repeat(100_000) });
    expect(res.status).toBe(413);
    expect((await me('POST', '/api/chat/messages', { text: 'x'.repeat(2000) })).status).toBe(200);
  });

  it('takes visitor photos up to 5 MB', async () => {
    const me = setup().browser();
    const form = (bytes: number) => {
      const f = new FormData();
      f.set('photo', padded(bytes));
      return f;
    };
    expect((await me('POST', '/api/chat/photos', form(4 * MB))).status).toBe(200);
    expect((await me('POST', '/api/chat/photos', form(6 * MB))).status).toBe(413);
  });

  it('takes a few camera-roll photos per request, and only from an admin', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const form = (n: number) => {
      const f = new FormData();
      for (let i = 0; i < n; i++) f.append('photo', new File([JPEG], `${i}.jpg`));
      return f;
    };
    const guest = t.browser();
    expect((await guest('POST', '/api/admin/photos', form(5))).status).toBe(403);

    const admin = t.browser();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    expect((await json<{ photos: unknown[] }>(await admin('POST', '/api/admin/photos', form(5)))).photos).toHaveLength(5);
    const tooMany = await admin('POST', '/api/admin/photos', form(6));
    expect(tooMany.status).toBe(400);
    expect((await json<{ error: string }>(tooMany)).error).toMatch(/up to 5/);
  });
});

describe('visitor cleanup', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const lastVisitor = (t: ReturnType<typeof setup>) =>
    (t.db.prepare('SELECT MAX(id) id FROM visitors').get() as { id: number }).id;
  const setSeen = (t: ReturnType<typeof setup>, id: number, iso: string) =>
    t.db.prepare('UPDATE visitors SET last_seen_at = ? WHERE id = ?').run(iso, id);
  const exists = (t: ReturnType<typeof setup>, id: number) => !!t.db.prepare('SELECT 1 FROM visitors WHERE id = ?').get(id);

  it('forgets visitors who never wrote, and chats whose cookie has expired, with their photos', async () => {
    const t = setup();

    // Opened the chat and looked at a story, but never wrote: gone after 30 days away.
    const lurker = t.browser();
    const [story] = (await json<{ stories: StoryDTO[] }>(await lurker('GET', '/api/stories'))).stories;
    await lurker('POST', `/api/stories/${story.id}/view`);
    const lurkerId = lastVisitor(t);
    setSeen(t, lurkerId, daysAgo(31));
    await t.browser()('GET', '/api/chat');
    const recentLurkerId = lastVisitor(t);
    setSeen(t, recentLurkerId, daysAgo(29));

    // Wrote to Alisa: kept until the cookie has expired.
    const chatter = t.browser();
    await chatter('POST', '/api/chat/messages', { text: 'hi' });
    const chatterId = lastVisitor(t);
    setSeen(t, chatterId, daysAgo(399));
    const gone = t.browser();
    const form = new FormData();
    form.set('photo', new File([JPEG], 'p.jpg', { type: 'image/jpeg' }));
    const photo = (await json<{ message: MessageDTO }>(await gone('POST', '/api/chat/photos', form))).message;
    const goneId = lastVisitor(t);
    const key = (t.db.prepare('SELECT media_key FROM messages WHERE id = ?').get(photo.id) as { media_key: string }).media_key;
    setSeen(t, goneId, daysAgo(402));

    t.db.prepare('INSERT INTO reply_counts (visitor_id, day, count) VALUES (?, ?, 3), (?, ?, 1)').run(
      chatterId,
      daysAgo(1).slice(0, 10),
      chatterId,
      daysAgo(0).slice(0, 10),
    );

    expect(await pruneVisitors(t.db, t.deps.media)).toEqual({ emptyVisitors: 1, expiredVisitors: 1, photos: 1, replyCounts: 1 });
    expect([lurkerId, recentLurkerId, chatterId, goneId].map((id) => exists(t, id))).toEqual([false, true, true, false]);
    expect(t.db.prepare('SELECT COUNT(*) n FROM story_views').get()).toEqual({ n: 0 });
    expect(await t.deps.media.storage.get(key)).toBeNull();
    expect((t.db.prepare('SELECT day FROM reply_counts').all() as { day: string }[]).map((r) => r.day)).toEqual([
      daysAgo(0).slice(0, 10),
    ]);

    // A forgotten browser just starts a new, empty chat.
    const chat = await json<ChatDTO>(await gone('GET', '/api/chat'));
    expect(chat.messages).toEqual([]);
  });

  it('removes stories a month after they expired, with their uploaded photos, but not from chats', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const admin = t.browser();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    const form = new FormData();
    form.set('kind', 'photo');
    form.set('photo', new File([JPEG], 's.jpg'));
    const posted = (await json<{ story: StoryDTO }>(await admin('POST', '/api/admin/stories', form))).story;
    const key = (t.db.prepare('SELECT media_key FROM stories WHERE id = ?').get(posted.id) as { media_key: string }).media_key;
    const me = t.browser();
    await me('POST', `/api/stories/${posted.id}/view`);
    await me('POST', `/api/stories/${posted.id}/reply`, { text: 'love this' });

    // Expired 29 days ago: kept. Then 31 days ago: gone, with its photo and views.
    const expire = (days: number) => t.db.prepare('UPDATE stories SET expires_at = ?').run(daysAgo(days));
    expire(29);
    expect(await pruneStories(t.db, t.deps.media)).toEqual({ stories: 0, photos: 0 });
    expire(31);
    const pruned = await pruneStories(t.db, t.deps.media);
    expect(pruned.stories).toBeGreaterThanOrEqual(5);
    expect(pruned.photos).toBe(1);
    expect(await t.deps.media.storage.get(key)).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) n FROM story_views').get()).toEqual({ n: 0 });
    const chat = await json<ChatDTO>(await me('GET', '/api/chat'));
    expect(chat.messages[0]).toMatchObject({ kind: 'story_reply', text: 'love this', story: { available: false } });
  });

  it('renews the cookie when a visitor comes back, so regulars keep their chat', async () => {
    const t = setup();
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hi' });
    const id = lastVisitor(t);
    expect((await me('GET', '/api/chat')).headers.getSetCookie()).toEqual([]);
    setSeen(t, id, daysAgo(2));
    const cookie = (await me('GET', '/api/chat')).headers.getSetCookie().join();
    expect(cookie).toMatch(/dmme_visitor=.*Max-Age=34560000/);
    expect(lastVisitor(t)).toBe(id);
    expect((await json<ChatDTO>(await me('GET', '/api/chat'))).messages).toHaveLength(1);
  });
});

describe('client address behind a proxy', () => {
  /** A request arriving over a socket from `peer`, with these headers. */
  const from = (peer: string, headers: Record<string, string> = {}) => ({
    init: { headers: { host: 'dm-me.test', ...headers } },
    env: { incoming: { socket: { remoteAddress: peer } } },
  });
  const seen = async (spec: string | undefined, req: ReturnType<typeof from>) => {
    const app = new Hono();
    app.use('*', clientInfo(new ProxyTrust(spec)));
    app.get('/', (c) => c.json(c.get('client')));
    return json<{ ip: string; https: boolean; host: string }>(await app.request('http://dm-me.test/', req.init, req.env));
  };
  const spoof = { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.test' };

  it('ignores forwarding headers from a connection that isn’t a trusted proxy', async () => {
    expect(await seen(undefined, from('203.0.113.5', spoof))).toEqual({ ip: '203.0.113.5', https: false, host: 'dm-me.test' });
  });

  it('believes a proxy on this machine, reading the address it added, not ones the client made up', async () => {
    const viaCaddy = from('::ffff:127.0.0.1', { ...spoof, 'x-forwarded-for': '6.6.6.6, 198.51.100.7' });
    expect(await seen(undefined, viaCaddy)).toEqual({ ip: '198.51.100.7', https: true, host: 'evil.test' });
    expect((await seen('off', viaCaddy)).ip).toBe('127.0.0.1');
  });

  it('follows a chain of trusted proxies from TRUST_PROXY', async () => {
    const chain = from('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.1.2.3' });
    expect((await seen('loopback, 10.0.0.0/8', chain)).ip).toBe('198.51.100.7');
    expect((await seen(undefined, chain)).ip).toBe('10.0.0.2');
    expect(() => new ProxyTrust('10.0.0.0/33')).toThrow(/TRUST_PROXY/);
    expect(() => new ProxyTrust('caddy')).toThrow(/TRUST_PROXY/);
  });

  it('won’t let a made-up address dodge the admin login limit', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const attempt = (i: number) => {
      const req = from('203.0.113.5', { origin: 'http://dm-me.test', 'content-type': 'application/json', 'x-forwarded-for': `6.6.6.${i}` });
      return t.app.request('http://dm-me.test/api/admin/login', { ...req.init, method: 'POST', body: '{"password":"guess"}' }, req.env);
    };
    for (let i = 0; i < 10; i++) expect((await attempt(i)).status).toBe(401);
    expect((await attempt(10)).status).toBe(429);
  });
});

describe('buildConversation', () => {
  it('replays Alisa’s turns in her reply format, hearts and photo references included', async () => {
    const base = {
      conversation_id: 1,
      media_key: null,
      media_mime: null,
      media_width: null,
      media_height: null,
      photo_mode: null,
      view_count: 0,
      story_id: null,
      story_snapshot: null,
      heart_by_user: 0,
      read_at: null,
      reply_to_id: null,
      context_seq: null,
      memory_text: null,
    };
    const rows: MessageRow[] = [
      { ...base, id: 1, sender: 'user', kind: 'text', text: 'got the job', heart_by_ai: 1, created_at: '2026-10-09T21:02:00.000Z' },
      { ...base, id: 2, sender: 'ai', kind: 'text', text: 'YES', heart_by_ai: 0, created_at: '2026-10-09T21:02:05.000Z' },
      { ...base, id: 3, sender: 'ai', kind: 'photo', text: null, media_key: 'library/x.jpg', photo_mode: 'once', heart_by_ai: 0, created_at: '2026-10-09T21:02:05.000Z' },
      { ...base, id: 4, sender: 'user', kind: 'text', text: 'thanks', heart_by_ai: 0, created_at: '2026-10-09T21:03:00.000Z', reply_to_id: 2 },
      { ...base, id: 5, sender: 'ai', kind: 'text', text: 'ofc', heart_by_ai: 0, created_at: '2026-10-09T21:03:05.000Z', reply_to_id: 4 },
    ];
    const media = { read: async () => null };
    const { messages } = await buildConversation(rows, media, 'UTC', new Map([['library/x.jpg', 'p7']]));
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '[m1 · Fri, Oct 9, 9:02 PM] got the job' }] });
    expect(JSON.parse(messages[1].content as string)).toEqual({
      messages: ['YES'],
      reply_to_message: 'none',
      heart_latest_user_message: true,
      send_photo: 'p7',
      send_photo_mode: 'once',
      remember_photo: '',
    });
    // Quote-replies both ways: theirs is spelled out, hers comes back as the reference she gave.
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[m4 · Fri, Oct 9, 9:03 PM] (replying to your message: "YES") thanks' }],
    });
    expect(JSON.parse(messages[3].content as string)).toMatchObject({ messages: ['ofc'], reply_to_message: 'm4' });
  });
});

describe('notifications', () => {
  const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'BPk', auth: 'au' } });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('notifies their devices when Alisa’s reply lands while the chat is closed', async () => {
    const t = setup({ typing: 40 });
    const me = t.browser();
    const status = await json<{ key: string; subscribed: boolean }>(await me('GET', '/api/chat/push'));
    expect(status.key.length).toBeGreaterThan(80);
    expect(status.subscribed).toBe(false);
    expect((await me('POST', '/api/chat/push', sub('https://push.example/a'))).status).toBe(200);
    expect((await json<{ subscribed: boolean }>(await me('GET', '/api/chat/push'))).subscribed).toBe(true);

    await me('POST', '/api/chat/messages', { text: 'night!' });
    await me('POST', '/api/chat/reply', {});
    expect(t.pushes).toHaveLength(0);
    // Her bubble ("You said: night!") is due a moment later; nobody fetched it, so a notification goes out.
    await wait(2000);
    expect(t.pushes).toEqual([
      { endpoint: 'https://push.example/a', payload: expect.objectContaining({ title: 'Alisa', body: 'You said: night!' }), subject: 'mailto:push@dm-me.invalid' },
    ]);
  });

  it('stays quiet while the chat is open, and forgets devices the browser dropped', async () => {
    const t = setup({ typing: 40 });
    const me = t.browser();
    await me('POST', '/api/chat/push', sub('https://push.example/gone'));
    await me('POST', '/api/chat/messages', { text: 'are u there' });
    await me('POST', '/api/chat/reply', {});
    // The open chat fetches her bubble when it's due.
    const due = (t.db.prepare("SELECT MAX(created_at) AS at FROM messages WHERE sender = 'ai'").get() as { at: string }).at;
    await wait(Date.parse(due) - Date.now() + 10);
    await me('GET', '/api/chat');
    await wait(500);
    expect(t.pushes).toHaveLength(0);

    t.pushFails.set('https://push.example/gone', 410);
    await me('POST', '/api/chat/messages', { text: 'hello?' });
    await me('POST', '/api/chat/reply', {});
    await wait(2000);
    expect((await json<{ subscribed: boolean }>(await me('GET', '/api/chat/push'))).subscribed).toBe(false);
  });

  it('only takes real push subscriptions', async () => {
    const me = setup().browser();
    expect((await me('POST', '/api/chat/push', { endpoint: 'http://insecure.example', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(400);
    expect((await me('POST', '/api/chat/push', { endpoint: 'https://push.example/x' })).status).toBe(400);
  });
});

describe('long chats', () => {
  /** Fills a visitor's chat with `n` read messages, alternating theirs and Alisa's. */
  const fill = (t: ReturnType<typeof setup>, conversationId: number, n: number) => {
    const insert = t.db.prepare(
      `INSERT INTO messages (conversation_id, sender, kind, text, created_at, read_at, context_seq) VALUES (?, ?, 'text', ?, ?, ?, ?)`,
    );
    const start = Date.now() - n * 60_000;
    for (let i = 0; i < n; i++) {
      const at = new Date(start + i * 60_000).toISOString();
      insert.run(conversationId, i % 2 ? 'ai' : 'user', `line ${i}`, at, at, i + 1);
    }
  };

  it('folds the oldest messages into what Alisa remembers, and sees the rest word for word', async () => {
    const t = setup();
    const me = t.browser();
    await me('GET', '/api/chat');
    const conversationId = (t.db.prepare('SELECT id FROM conversations').get() as { id: number }).id;
    fill(t, conversationId, 130);
    await me('POST', '/api/chat/messages', { text: 'still there?' });
    await me('POST', '/api/chat/reply', {});
    // The first reply saw all 131 (nothing summarized yet) and then started the summary.
    await t.deps.replies.settled();
    expect(t.fake.summaries).toHaveLength(1);
    const first = t.fake.summaries[0];
    expect(first.previous).toBeNull();
    expect(first.transcript.split('\n')).toHaveLength(132 - 80);
    expect(first.transcript).toMatch(/^Them \(.*\): line 0\nYou: line 1\n/);
    const conv = t.db.prepare('SELECT summary, summarized FROM conversations').get() as { summary: string; summarized: number };
    expect(conv).toEqual({ summary: '(remembered 52 lines)', summarized: 52 });

    // The next reply starts from that memory and sees only the newer 80 and what came since.
    await me('POST', '/api/chat/messages', { text: 'hello??' });
    await me('POST', '/api/chat/reply', {});
    const seen = t.fake.calls[1].messages;
    expect(JSON.stringify(seen[0])).toContain('(earlier in this chat, which you remember: (remembered 52 lines))');
    expect(JSON.stringify(seen)).not.toContain('line 50"');
    expect(JSON.stringify(seen)).toContain('line 52"');
    await t.deps.replies.settled();
    // Not again until the window passes 120 messages more.
    expect(t.fake.summaries).toHaveLength(1);
  });

  it('throws away a summary for a chat deleted while it was being written', async () => {
    const t = setup();
    const me = t.browser();
    await me('GET', '/api/chat');
    const conversationId = (t.db.prepare('SELECT id FROM conversations').get() as { id: number }).id;
    fill(t, conversationId, 130);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const summarize = t.fake.summarize.bind(t.fake);
    t.fake.summarize = async (prev, transcript) => {
      await gate;
      return summarize(prev, transcript);
    };
    await me('POST', '/api/chat/messages', { text: 'hi' });
    await me('POST', '/api/chat/reply', {});
    await me('DELETE', '/api/chat');
    release();
    await t.deps.replies.settled();
    expect(t.db.prepare('SELECT summary, summarized FROM conversations').all()).toEqual([{ summary: null, summarized: 0 }]);
  });
});

describe('races and limits around a reply', () => {
  /** Holds Alisa's next reply until `release()`, so something can happen while she "writes". */
  const hold = (t: ReturnType<typeof setup>, change?: (r: Awaited<ReturnType<FakeResponder['reply']>>) => void) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reply = t.fake.reply.bind(t.fake);
    t.fake.reply = async (req) => {
      await gate;
      const r = await reply(req);
      change?.(r);
      return r;
    };
    return () => release();
  };

  it('drops a reply quietly when the chat was deleted while Alisa was writing it', async () => {
    const t = setup();
    const release = hold(t);
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hey' });
    const thinking = me('POST', '/api/chat/reply', {});
    await new Promise((r) => setTimeout(r, 20));
    await me('DELETE', '/api/chat');
    release();
    const res = await thinking;
    expect(res.status).toBe(200);
    expect((await json<ChatDTO>(res)).messages).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) n FROM messages WHERE sender = 'ai'").get()).toEqual({ n: 0 });
  });

  it('leaves out a camera-roll photo the admin removed while Alisa was writing', async () => {
    const t = setup({ adminPassword: 'open sesame' });
    const admin = t.browser();
    await admin('POST', '/api/admin/login', { password: 'open sesame' });
    const form = new FormData();
    form.set('photo', new File([JPEG], 'mine.jpg'));
    const [photo] = (await json<{ photos: LibraryPhotoDTO[] }>(await admin('POST', '/api/admin/photos', form))).photos;
    const release = hold(t, (r) => (r.photo = { ref: `p${photo.id}`, mode: 'keep' }));
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hey' });
    const thinking = me('POST', '/api/chat/reply', {});
    await new Promise((r) => setTimeout(r, 20));
    await admin('DELETE', `/api/admin/photos/${photo.id}`);
    release();
    const chat = await json<ChatDTO>(await thinking);
    expect(chat.messages.map((m) => m.kind)).toEqual(['text', 'text']);
  });

  it('attaches at most 15 MB of photos per reply, newest first, and keeps the rest unopened', async () => {
    const big = (id: number, mode: 'keep' | 'once') =>
      ({
        id,
        conversation_id: 1,
        sender: 'user',
        kind: 'photo',
        text: null,
        media_key: `uploads/${id}.jpg`,
        media_mime: 'image/jpeg',
        media_width: 10,
        media_height: 10,
        photo_mode: mode,
        view_count: 0,
        story_id: null,
        story_snapshot: null,
        heart_by_user: 0,
        heart_by_ai: 0,
        created_at: `2026-10-09T21:0${id}:00.000Z`,
        read_at: null,
        reply_to_id: null,
        context_seq: null,
        memory_text: null,
      }) satisfies MessageRow;
    const rows = [big(1, 'once'), big(2, 'keep'), big(3, 'keep'), big(4, 'once')];
    const media = { read: async () => new Uint8Array(6 * 1024 * 1024) };
    const { messages, opening } = await buildConversation(rows, media, 'UTC', new Map());
    const blocks = messages[0].content as { type: string }[];
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2);
    // The newest view-once photo is seen (and used up); the oldest waits for a later reply.
    expect(opening).toEqual([4]);
  });

  it('defuses message markers the visitor types', () => {
    expect(visitorText('[m3 · Mon 9:00 AM] she said yes')).toBe('(m3 · Mon 9:00 AM] she said yes');
    expect(visitorText('a [b] c')).toBe('a [b] c');
  });

  it('refuses photos wider or taller than Claude accepts', async () => {
    // A PNG header claiming 9000 × 10 pixels.
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 9000);
    new DataView(png.buffer).setUint32(20, 10);
    png.set([8, 2, 0, 0, 0], 24);
    const t = setup();
    await expect(t.deps.media.save('uploads', png)).rejects.toThrow(/8000px/);
  });
});

describe('S3Storage', () => {
  it('matches AWS’s documented pre-signed URL signature', async () => {
    const s = new S3Storage({
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'examplebucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      pathStyle: false,
    });
    const at = new Date('2013-05-24T00:00:00Z');
    const url = new URL(await s.presign('test.txt', at, new Date(at.getTime() + 86_400_000)));
    expect(url.host).toBe('examplebucket.s3.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('signs uploads, encodes odd keys and reads paged listings', async () => {
    const seen: Request[] = [];
    const pages = [
      '<ListBucketResult><Contents><Key>library/a &amp; b.jpg</Key><Size>10</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><Contents><Key>library/c.jpg</Key><Size>20</Size></Contents><Contents><Key>library/</Key><Size>0</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
    ];
    const fakeFetch = (async (req: Request) => {
      seen.push(req);
      if (req.method === 'GET' && new URL(req.url).searchParams.get('list-type')) return new Response(pages.shift());
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const s = new S3Storage({
      endpoint: 'https://acc.r2.cloudflarestorage.com',
      bucket: 'dmme',
      region: 'auto',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      pathStyle: true,
      fetch: fakeFetch,
    });
    await s.put('library/Beach day (1).jpg', JPEG, 'image/jpeg');
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].url).toBe('https://acc.r2.cloudflarestorage.com/dmme/library/Beach%20day%20%281%29.jpg');
    expect(seen[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/auto\/s3\/aws4_request/);

    const listed = await s.list('library/');
    expect(listed).toEqual([
      { key: 'library/a & b.jpg', size: 10 },
      { key: 'library/c.jpg', size: 20 },
    ]);
    expect(new URL(seen[2].url).searchParams.get('continuation-token')).toBe('t2');
    await expect(s.put('../escape.jpg', JPEG, 'image/jpeg')).rejects.toThrow('Bad storage key');
  });
});
