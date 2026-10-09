import type { ChatDTO, MessageDTO, OpenPhotoDTO, PhotoMode, StoryBg, StoryDTO, UserDTO } from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('You appear to be offline.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

export const api = {
  me: () => request<{ user: UserDTO }>('GET', '/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: UserDTO }>('POST', '/api/auth/login', { username, password }),
  signup: (username: string, password: string) =>
    request<{ user: UserDTO }>('POST', '/api/auth/signup', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  chat: () => request<ChatDTO>('GET', '/api/chat'),
  sendText: (text: string) => request<{ message: MessageDTO }>('POST', '/api/chat/messages', { text }),
  sendPhoto: (blob: Blob, mode: PhotoMode, width: number, height: number) => {
    const form = new FormData();
    form.set('photo', blob, 'photo.jpg');
    form.set('mode', mode);
    form.set('width', String(width));
    form.set('height', String(height));
    return request<{ message: MessageDTO }>('POST', '/api/chat/photos', form);
  },
  reply: () =>
    request<ChatDTO>('POST', '/api/chat/reply', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  heart: (id: number, on: boolean) => request<{ message: MessageDTO }>('POST', `/api/chat/messages/${id}/heart`, { on }),
  openPhoto: (id: number) => request<OpenPhotoDTO>('POST', `/api/chat/messages/${id}/open`),

  stories: () => request<{ stories: StoryDTO[] }>('GET', '/api/stories'),
  viewStory: (id: number) => request<{ ok: true }>('POST', `/api/stories/${id}/view`),
  likeStory: (id: number, on: boolean) => request<{ liked: boolean }>('POST', `/api/stories/${id}/like`, { on }),
  replyToStory: (id: number, text: string) =>
    request<{ message: MessageDTO }>('POST', `/api/stories/${id}/reply`, { text }),

  admin: {
    stories: () => request<{ stories: (StoryDTO & { active: boolean; views: number })[] }>('GET', '/api/admin/stories'),
    create: (input: { kind: 'photo' | 'text'; caption: string; bg: StoryBg; hours: number; photo?: Blob }) => {
      const form = new FormData();
      form.set('kind', input.kind);
      form.set('caption', input.caption);
      form.set('bg', input.bg);
      form.set('hours', String(input.hours));
      if (input.photo) form.set('photo', input.photo, 'story.jpg');
      return request<{ story: StoryDTO }>('POST', '/api/admin/stories', form);
    },
    remove: (id: number) => request<{ ok: true }>('DELETE', `/api/admin/stories/${id}`),
  },
};
