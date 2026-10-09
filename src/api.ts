import type { AdminStoryDTO, ChatDTO, LibraryPhotoDTO, MessageDTO, OpenPhotoDTO, PhotoMode, StoryBg, StoryDTO } from '../shared/types';

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
  chat: () => request<ChatDTO>('GET', '/api/chat'),
  deleteChat: () => request<ChatDTO>('DELETE', '/api/chat'),
  sendText: (text: string) => request<{ message: MessageDTO }>('POST', '/api/chat/messages', { text }),
  sendPhoto: (blob: Blob, mode: PhotoMode) => {
    const form = new FormData();
    form.set('photo', blob, 'photo.jpg');
    form.set('mode', mode);
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
    me: () => request<{ enabled: boolean; admin: boolean; storage: 'local' | 's3' }>('GET', '/api/admin/me'),
    login: (password: string) => request<{ ok: true }>('POST', '/api/admin/login', { password }),
    logout: () => request<{ ok: true }>('POST', '/api/admin/logout'),
    stories: () => request<{ stories: AdminStoryDTO[] }>('GET', '/api/admin/stories'),
    createStory: (input: { kind: 'photo' | 'text'; caption: string; bg: StoryBg; hours: number; photo?: Blob }) => {
      const form = new FormData();
      form.set('kind', input.kind);
      form.set('caption', input.caption);
      form.set('bg', input.bg);
      form.set('hours', String(input.hours));
      if (input.photo) form.set('photo', input.photo, 'story.jpg');
      return request<{ story: AdminStoryDTO }>('POST', '/api/admin/stories', form);
    },
    removeStory: (id: number) => request<{ ok: true }>('DELETE', `/api/admin/stories/${id}`),
    photos: () => request<{ photos: LibraryPhotoDTO[] }>('GET', '/api/admin/photos'),
    addPhotos: (photos: Blob[], description: string) => {
      const form = new FormData();
      photos.forEach((p, i) => form.append('photo', p, `photo-${i}.jpg`));
      form.set('description', description);
      return request<{ photos: LibraryPhotoDTO[] }>('POST', '/api/admin/photos', form);
    },
    describePhoto: (id: number, description: string) =>
      request<{ ok: true }>('PATCH', `/api/admin/photos/${id}`, { description }),
    removePhoto: (id: number) => request<{ ok: true }>('DELETE', `/api/admin/photos/${id}`),
    syncPhotos: () => request<{ added: number; remaining: number; skipped: string[] }>('POST', '/api/admin/photos/sync'),
  },
};
