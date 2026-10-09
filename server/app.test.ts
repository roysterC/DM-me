import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatDTO, LibraryPhotoDTO, MessageDTO, OpenPhotoDTO, StoryDTO } from '../shared/types';
import { buildConversation } from './ai/context';
import { FakeResponder } from './ai/responder';
import { createApp } from './app';
import { loadConfig } from './config';
import { type MessageRow, openDb } from './db';
import { S3Storage } from './storage';

const JPEG = new Uint8Array(fs.readFileSync(path.resolve('server/assets/skillet.jpg')));

function setup(opts: { connected?: boolean; adminPassword?: string; dailyReplyLimit?: number } = {}) {
  const config = loadConfig({
    dataDir: ':memory:',
    secret: 'test-secret',
    s3: null,
    fakeAi: false,
    adminPassword: opts.adminPassword ?? '',
    autoStories: true,
    seedSamplePhotos: true,
    dailyReplyLimit: opts.dailyReplyLimit ?? 200,
  });
  const db = openDb(':memory:');
  const fake = new FakeResponder();
  const { app, deps } = createApp(db, config, opts.connected === false ? null : fake);

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

  return { app, db, deps, fake, browser, photoForm };
}

const json = async <T>(res: Response) => (await res.json()) as T;

describe('visitors', () => {
  it('gives each browser its own chat without any sign-up', async () => {
    const t = setup();
    const maya = t.browser();
    const sam = t.browser();
    const first = await json<ChatDTO>(await maya('GET', '/api/chat'));
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].sender).toBe('ai');

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
    expect(after.messages).toHaveLength(1);
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
    expect(sent[0]).toEqual({ role: 'user', content: '(opened the chat)' });
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(t.fake.calls[0].system).toContain('p1: a baked egg skillet');
    expect(after.messages.at(-1)).toMatchObject({ sender: 'ai', text: 'You said: ok be honest is it weird' });
    expect(after.messages.filter((m) => m.sender === 'user').every((m) => m.readAt)).toBe(true);

    await me('POST', '/api/chat/reply', {});
    expect(t.fake.calls).toHaveLength(1);
  });

  it('says so when Nova is not connected', async () => {
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

  it('lets the visitor heart Nova’s messages, and Nova heart theirs', async () => {
    const t = setup();
    const me = t.browser();
    const chat = await json<ChatDTO>(await me('GET', '/api/chat'));
    const res = await me('POST', `/api/chat/messages/${chat.messages[0].id}/heart`, { on: true });
    expect((await json<{ message: MessageDTO }>(res)).message.heartByUser).toBe(true);

    await me('POST', '/api/chat/messages', { text: 'got the job! heart this' });
    const after = await json<ChatDTO>(await me('POST', '/api/chat/reply', {}));
    expect(after.messages.find((m) => m.text === 'got the job! heart this')?.heartByAi).toBe(true);
  });
});

describe('photos', () => {
  it('shows kept photos to Nova and serves them through signed links', async () => {
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

  it('lets Nova see a view-once photo exactly once, then deletes it', async () => {
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
    expect(second).toContain('view-once photo that you already viewed');
  });

  it('limits opens of photos Nova sends: once means once, replay means twice', async () => {
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

  it('refuses files that are not images', async () => {
    const t = setup();
    const me = t.browser();
    const form = new FormData();
    form.set('photo', new File(['<script>alert(1)</script>'], 'x.jpg', { type: 'image/jpeg' }));
    expect((await me('POST', '/api/chat/photos', form)).status).toBe(400);
  });
});

describe('stories', () => {
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

  it('manages Nova’s camera roll: upload, describe, edit, delete and sync from the bucket', async () => {
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

    // Nova is offered exactly the visible camera roll.
    const me = t.browser();
    await me('POST', '/api/chat/messages', { text: 'hi' });
    await me('POST', '/api/chat/reply', {});
    expect(t.fake.calls[0].photoRefs.sort()).toEqual(photos.map((p) => `p${p.id}`).sort());
  });
});

describe('buildConversation', () => {
  it('replays Nova’s turns in her reply format, hearts and photo references included', async () => {
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
    };
    const rows: MessageRow[] = [
      { ...base, id: 1, sender: 'user', kind: 'text', text: 'got the job', heart_by_ai: 1, created_at: '2026-10-09T21:02:00.000Z' },
      { ...base, id: 2, sender: 'ai', kind: 'text', text: 'YES', heart_by_ai: 0, created_at: '2026-10-09T21:02:05.000Z' },
      { ...base, id: 3, sender: 'ai', kind: 'photo', text: null, media_key: 'library/x.jpg', photo_mode: 'once', heart_by_ai: 0, created_at: '2026-10-09T21:02:05.000Z' },
      { ...base, id: 4, sender: 'user', kind: 'text', text: 'thanks', heart_by_ai: 0, created_at: '2026-10-09T21:03:00.000Z' },
    ];
    const media = { read: async () => null };
    const { messages } = await buildConversation(rows, media, 'UTC', new Map([['library/x.jpg', 'p7']]));
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '[Fri, Oct 9, 9:02 PM] got the job' }] });
    expect(JSON.parse(messages[1].content as string)).toEqual({
      messages: ['YES'],
      heart_latest_user_message: true,
      send_photo: 'p7',
      send_photo_mode: 'once',
    });
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
