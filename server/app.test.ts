import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatDTO, MessageDTO, OpenPhotoDTO, StoryDTO } from '../shared/types';
import { createApp } from './app';
import { FakeResponder } from './ai/responder';
import { buildConversation } from './ai/context';
import { loadConfig } from './config';
import { openDb, type MessageRow } from './db';

const JPEG = fs.readFileSync(path.resolve('server/assets/skillet.jpg'));
const ORIGIN = 'http://localhost';

function setup(opts: { connected?: boolean; admins?: string[] } = {}) {
  const config = loadConfig({
    dataDir: ':memory:',
    fakeAi: false,
    adminUsernames: new Set(opts.admins ?? []),
    autoStories: true,
  });
  const db = openDb(':memory:');
  const fake = new FakeResponder();
  const { app, deps } = createApp(db, config, opts.connected === false ? null : fake);

  const call = async (method: string, url: string, cookie?: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: ORIGIN, host: 'localhost' };
    if (cookie) headers.cookie = cookie;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return app.request(`http://localhost${url}`, { method, headers, body: payload });
  };

  const signup = async (username: string) => {
    const res = await call('POST', '/api/auth/signup', undefined, { username, password: 'correct horse' });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0];
  };

  const sendPhoto = async (cookie: string, mode: string) => {
    const form = new FormData();
    form.set('photo', new File([JPEG], 'p.jpg', { type: 'image/jpeg' }));
    form.set('mode', mode);
    form.set('width', '800');
    form.set('height', '666');
    const res = await call('POST', '/api/chat/photos', cookie, form);
    expect(res.status).toBe(200);
    return ((await res.json()) as { message: MessageDTO }).message;
  };

  return { app, db, deps, fake, call, signup, sendPhoto };
}

describe('accounts', () => {
  it('signs up, reads the session, logs out and logs back in', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    const me = await t.call('GET', '/api/auth/me', cookie);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe('maya');

    expect((await t.call('POST', '/api/auth/signup', undefined, { username: 'MAYA', password: 'another pass' })).status).toBe(409);
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'maya', password: 'wrong pass' })).status).toBe(401);

    await t.call('POST', '/api/auth/logout', cookie);
    expect((await t.call('GET', '/api/auth/me', cookie)).status).toBe(401);
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'Maya', password: 'correct horse' })).status).toBe(200);
  });

  it('rejects short passwords and odd usernames', async () => {
    const t = setup();
    expect((await t.call('POST', '/api/auth/signup', undefined, { username: 'ok_name', password: 'short' })).status).toBe(400);
    expect((await t.call('POST', '/api/auth/signup', undefined, { username: 'no spaces', password: 'long enough' })).status).toBe(400);
  });

  it('blocks cross-site writes', async () => {
    const t = setup();
    const res = await t.app.request('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: { origin: 'https://evil.example', host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'maya', password: 'correct horse' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('chat', () => {
  it('starts with Nova’s greeting and replies to a burst of messages at once', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    const chat = (await (await t.call('GET', '/api/chat', cookie)).json()) as ChatDTO;
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].sender).toBe('ai');
    expect(chat.aiConnected).toBe(true);

    await t.call('POST', '/api/chat/messages', cookie, { text: 'ok be honest' });
    await t.call('POST', '/api/chat/messages', cookie, { text: 'is it weird' });
    const res = await t.call('POST', '/api/chat/reply', cookie, { timeZone: 'America/New_York' });
    const after = (await res.json()) as ChatDTO;

    expect(t.fake.calls).toHaveLength(1);
    const sent = t.fake.calls[0].messages;
    expect(sent[0]).toEqual({ role: 'user', content: '(opened the chat)' });
    expect(sent[1].role).toBe('assistant');
    expect(sent[2].role).toBe('user');
    expect(after.messages.at(-1)).toMatchObject({ sender: 'ai', text: 'You said: ok be honest is it weird' });
    expect(after.messages.filter((m) => m.sender === 'user').every((m) => m.readAt)).toBe(true);

    // Nothing new from the user: no second call.
    await t.call('POST', '/api/chat/reply', cookie, {});
    expect(t.fake.calls).toHaveLength(1);
  });

  it('says so when Nova is not connected', async () => {
    const t = setup({ connected: false });
    const cookie = await t.signup('maya');
    await t.call('POST', '/api/chat/messages', cookie, { text: 'hi' });
    const res = await t.call('POST', '/api/chat/reply', cookie, {});
    expect(res.status).toBe(503);
    expect(((await (await t.call('GET', '/api/chat', cookie)).json()) as ChatDTO).aiConnected).toBe(false);
  });

  it('lets the user heart Nova’s messages, and Nova heart theirs', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    const chat = (await (await t.call('GET', '/api/chat', cookie)).json()) as ChatDTO;
    const res = await t.call('POST', `/api/chat/messages/${chat.messages[0].id}/heart`, cookie, { on: true });
    expect(((await res.json()) as { message: MessageDTO }).message.heartByUser).toBe(true);

    await t.call('POST', '/api/chat/messages', cookie, { text: 'got the job! heart this' });
    const after = (await (await t.call('POST', '/api/chat/reply', cookie, {})).json()) as ChatDTO;
    expect(after.messages.find((m) => m.text === 'got the job! heart this')?.heartByAi).toBe(true);
  });
});

describe('photos', () => {
  it('shows kept photos to Nova and serves them only to their owner', async () => {
    const t = setup();
    const maya = await t.signup('maya');
    const other = await t.signup('sam');
    const photo = await t.sendPhoto(maya, 'keep');
    expect(photo.photo?.url).toBe(`/api/media/message/${photo.id}`);

    await t.call('POST', '/api/chat/reply', maya, {});
    const lastTurn = t.fake.calls[0].messages.at(-1)!;
    expect(Array.isArray(lastTurn.content) && lastTurn.content.some((b) => b.type === 'image')).toBe(true);

    expect((await t.call('GET', photo.photo!.url!, maya)).status).toBe(200);
    expect((await t.call('GET', photo.photo!.url!, other)).status).toBe(404);
  });

  it('lets Nova see a view-once photo exactly once, then deletes it', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    const sent = await t.sendPhoto(cookie, 'once');
    expect(sent.photo).toMatchObject({ mode: 'once', url: null, viewCount: 0, maxViews: 1 });
    const file = (t.db.prepare('SELECT media_file FROM messages WHERE id = ?').get(sent.id) as MessageRow).media_file!;
    expect(t.deps.media.exists(file)).toBe(true);

    const after = (await (await t.call('POST', '/api/chat/reply', cookie, {})).json()) as ChatDTO;
    expect(after.messages.find((m) => m.id === sent.id)?.photo?.viewCount).toBe(1);
    expect(t.deps.media.exists(file)).toBe(false);

    await t.call('POST', '/api/chat/messages', cookie, { text: 'did you like it' });
    await t.call('POST', '/api/chat/reply', cookie, {});
    const second = JSON.stringify(t.fake.calls[1].messages);
    expect(second).not.toContain('"type":"image"');
    expect(second).toContain('view-once photo that you already viewed');
  });

  it('limits opens of photos Nova sends: once means once, replay means twice', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    await t.call('POST', '/api/chat/messages', cookie, { text: 'send me a photo' });
    let chat = (await (await t.call('POST', '/api/chat/reply', cookie, {})).json()) as ChatDTO;
    const once = chat.messages.find((m) => m.sender === 'ai' && m.kind === 'photo')!;
    expect(once.photo).toMatchObject({ mode: 'once', url: null });

    const open = await t.call('POST', `/api/chat/messages/${once.id}/open`, cookie);
    const opened = (await open.json()) as OpenPhotoDTO;
    expect(opened).toMatchObject({ viewCount: 1, maxViews: 1, seconds: 5 });
    expect((await t.call('GET', opened.url, cookie)).status).toBe(200);
    expect((await t.call('GET', opened.url, cookie)).status).toBe(410);
    expect((await t.call('POST', `/api/chat/messages/${once.id}/open`, cookie)).status).toBe(410);

    await t.call('POST', '/api/chat/messages', cookie, { text: 'another photo, replay ok' });
    chat = (await (await t.call('POST', '/api/chat/reply', cookie, {})).json()) as ChatDTO;
    const replay = chat.messages.filter((m) => m.kind === 'photo' && m.sender === 'ai').at(-1)!;
    expect(replay.photo?.mode).toBe('replay');
    expect((await t.call('POST', `/api/chat/messages/${replay.id}/open`, cookie)).status).toBe(200);
    expect((await t.call('POST', `/api/chat/messages/${replay.id}/open`, cookie)).status).toBe(200);
    expect((await t.call('POST', `/api/chat/messages/${replay.id}/open`, cookie)).status).toBe(410);
  });

  it('refuses files that are not images', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    const form = new FormData();
    form.set('photo', new File(['<script>alert(1)</script>'], 'x.jpg', { type: 'image/jpeg' }));
    expect((await t.call('POST', '/api/chat/photos', cookie, form)).status).toBe(400);
  });
});

describe('stories', () => {
  it('posts sample stories, tracks views and likes, and turns replies into DMs', async () => {
    const t = setup();
    const cookie = await t.signup('maya');
    let stories = ((await (await t.call('GET', '/api/stories', cookie)).json()) as { stories: StoryDTO[] }).stories;
    expect(stories).toHaveLength(4);
    expect(stories.every((s) => !s.seen)).toBe(true);

    await t.call('POST', `/api/stories/${stories[0].id}/view`, cookie);
    await t.call('POST', `/api/stories/${stories[0].id}/like`, cookie, { on: true });
    stories = ((await (await t.call('GET', '/api/stories', cookie)).json()) as { stories: StoryDTO[] }).stories;
    expect(stories[0]).toMatchObject({ seen: true, liked: true });
    expect(stories[1].seen).toBe(false);

    const media = await t.call('GET', stories[0].mediaUrl!, cookie);
    expect(media.headers.get('content-type')).toBe('image/jpeg');

    const reply = await t.call('POST', `/api/stories/${stories[1].id}/reply`, cookie, { text: 'dinner' });
    const msg = ((await reply.json()) as { message: MessageDTO }).message;
    expect(msg).toMatchObject({ kind: 'story_reply', text: 'dinner', story: { available: true, kind: 'text' } });

    await t.call('POST', '/api/chat/reply', cookie, {});
    expect(JSON.stringify(t.fake.calls[0].messages)).toContain('replied to your story \\"3 dinners under 15 minutes');
  });

  it('lets admins post and delete stories, and nobody else', async () => {
    const t = setup({ admins: ['boss'] });
    const user = await t.signup('maya');
    const admin = await t.signup('boss');
    const form = () => {
      const f = new FormData();
      f.set('kind', 'text');
      f.set('caption', 'New drop');
      f.set('bg', 'ocean');
      return f;
    };
    expect((await t.call('POST', '/api/admin/stories', user, form())).status).toBe(403);
    const created = await t.call('POST', '/api/admin/stories', admin, form());
    const story = ((await created.json()) as { story: StoryDTO }).story;
    expect(story).toMatchObject({ kind: 'text', caption: 'New drop', bg: 'ocean' });

    let live = ((await (await t.call('GET', '/api/stories', user)).json()) as { stories: StoryDTO[] }).stories;
    expect(live.at(-1)?.caption).toBe('New drop');
    await t.call('DELETE', `/api/admin/stories/${story.id}`, admin);
    live = ((await (await t.call('GET', '/api/stories', user)).json()) as { stories: StoryDTO[] }).stories;
    expect(live.some((s) => s.id === story.id)).toBe(false);
  });
});

describe('buildConversation', () => {
  it('replays Nova’s turns in her reply format, hearts included', () => {
    const base = { conversation_id: 1, media_file: null, media_mime: null, media_width: null, media_height: null, photo_mode: null, view_count: 0, story_id: null, story_snapshot: null, heart_by_user: 0, read_at: null };
    const rows: MessageRow[] = [
      { ...base, id: 1, sender: 'user', kind: 'text', text: 'got the job', heart_by_ai: 1, created_at: '2026-10-09T21:02:00.000Z' },
      { ...base, id: 2, sender: 'ai', kind: 'text', text: 'YES', heart_by_ai: 0, created_at: '2026-10-09T21:02:05.000Z' },
      { ...base, id: 3, sender: 'ai', kind: 'photo', text: null, media_file: 'asset:coffee.jpg', photo_mode: 'once', heart_by_ai: 0, created_at: '2026-10-09T21:02:05.000Z' },
      { ...base, id: 4, sender: 'user', kind: 'text', text: 'thanks', heart_by_ai: 0, created_at: '2026-10-09T21:03:00.000Z' },
    ];
    const media = { exists: () => false, read: () => null } as never;
    const { messages } = buildConversation(rows, media, 'UTC');
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '[Fri, Oct 9, 9:02 PM] got the job' }] });
    expect(JSON.parse(messages[1].content as string)).toEqual({
      messages: ['YES'],
      heart_latest_user_message: true,
      send_photo: 'coffee',
      send_photo_mode: 'once',
    });
    expect(messages[2].role).toBe('user');
  });
});
