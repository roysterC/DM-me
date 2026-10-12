import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatDTO, OpenPhotoDTO, PhotoMode, ReplyRefDTO, StoryDTO } from '../../shared/types';
import { api, ApiError } from '../api';
import type { PreparedImage } from './image';
import { forgetPreloadsExcept, preloadImage } from './preload';
import { mergeServer, type UiMessage } from './thread';

/** How long to wait after the user's last message before asking for Alisa's reply, so bursts get one reply. */
const REPLY_DELAY_MS = 1200;
/** When one of Alisa's bubbles lands, the typing dots pause this long before she starts the next. */
const TYPING_PAUSE_MS = 600;
/** Fetch a due bubble this long after its time, so it's surely showing on the server. */
const DUE_SLACK_MS = 150;
/**
 * Photo links from the server last at least an hour; re-fetch the chat and stories once what's
 * on screen is older than this, so a tab left open never shows broken photos.
 */
const STALE_MS = 30 * 60_000;

/** What a reply shows of the message it quotes. */
export const quoteOf = (m: UiMessage): ReplyRefDTO => ({
  id: m.id,
  sender: m.sender,
  text: m.kind === 'photo' ? null : m.text,
  photo: m.kind === 'photo',
});

/**
 * Whether Alisa owes a reply: something the visitor sent that she hasn't read, or
 * (after a failed attempt) a last message from them she never answered. With her
 * bubbles landing over time, the visitor's message isn't always the last one shown.
 */
function needsReply(list: UiMessage[], queued = false): boolean {
  if (list.some((m) => m.sender === 'user' && !m.pending && !m.readAt)) return true;
  // While her bubbles are still due, the visitor's message shows last but is already answered.
  if (queued) return false;
  const last = list.at(-1);
  return !!last && last.sender === 'user' && !last.pending;
}

/**
 * The chat's data and Alisa's side of it: loading, sending (shown at once, confirmed by the
 * server), asking for her reply after a burst of messages, showing "typing…" until each of
 * her bubbles is due, and stories. `onSend` runs whenever the visitor sends something.
 */
export function useChat({ onSend }: { onSend?: () => void } = {}) {
  const [chat, setChat] = useState<Omit<ChatDTO, 'messages' | 'upcoming'> | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [stories, setStories] = useState<StoryDTO[]>([]);
  // Typing shows while the reply is being written, and while her bubbles are still due.
  const [waiting, setWaiting] = useState(false);
  const [queued, setQueued] = useState(false);
  const [paused, setPaused] = useState(false);
  const [seenNow, setSeenNow] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const messagesRef = useRef<UiMessage[]>([]);
  const replyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queuedRef = useRef(false);
  const dueTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pauseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const replying = useRef(false);
  const nextTempId = useRef(-1);
  const retryPayload = useRef(new Map<number, () => Promise<boolean>>());
  const scheduleReplyRef = useRef<(delay?: number) => void>(() => {});
  // False once the page is gone: async work that finishes later must not start timers again.
  const alive = useRef(true);
  // Bumped by each follow(); a fetch from an older one is out of date when it lands.
  const followGen = useRef(0);
  // When the chat was last fetched, for re-signing photo links in long-open tabs.
  const fetchedAt = useRef(Date.now());
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  messagesRef.current = messages;

  /** Changes messages in state and in the ref the timers read, together. */
  const update = useCallback((fn: (list: UiMessage[]) => UiMessage[]) => {
    messagesRef.current = fn(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  // ---- Alisa's replies -------------------------------------------------------

  /** Takes the server's view of the chat, keeping what the visitor sent since (or is still sending). */
  const applyServer = useCallback(
    (list: UiMessage[]) => {
      fetchedAt.current = Date.now();
      update((cur) => mergeServer(list, cur));
    },
    [update],
  );

  const replyIfUnanswered = useCallback(() => {
    if (needsReply(messagesRef.current, queuedRef.current)) scheduleReplyRef.current(REPLY_DELAY_MS);
  }, []);

  /** Shows "typing…" until each of Alisa's queued bubbles is due, then fetches it. */
  const follow = useCallback(
    (upcoming: number[]) => {
      clearTimeout(dueTimer.current);
      const gen = ++followGen.current;
      queuedRef.current = upcoming.length > 0;
      setQueued(upcoming.length > 0);
      if (upcoming.length === 0 || !alive.current) return;
      dueTimer.current = setTimeout(async () => {
        try {
          const c = await api.chat();
          // The page closed, or a newer reply took over following, while this was loading.
          if (!alive.current || gen !== followGen.current) return;
          applyServer(c.messages);
          if (c.upcoming.length) {
            setPaused(true);
            clearTimeout(pauseTimer.current);
            pauseTimer.current = setTimeout(() => setPaused(false), TYPING_PAUSE_MS);
          }
          follow(c.upcoming);
          if (!c.upcoming.length) replyIfUnanswered();
        } catch {
          if (alive.current && gen === followGen.current) follow(upcoming.map(() => 3000));
        }
      }, Math.max(0, Math.min(...upcoming)) + DUE_SLACK_MS);
    },
    [applyServer, replyIfUnanswered],
  );

  const runReply = useCallback(async () => {
    if (replying.current || !needsReply(messagesRef.current, queuedRef.current)) return;
    replying.current = true;
    setReplyError(null);
    setSeenNow(true);
    const typingTimer = setTimeout(() => setWaiting(true), 500);
    let ok = false;
    try {
      const res = await api.reply();
      if (!alive.current) return;
      applyServer(res.messages);
      follow(res.upcoming);
      ok = true;
    } catch (err) {
      // No automatic retry: the error stays up with its Retry button, and the next message
      // the visitor sends asks again. Retrying on a timer would hammer the server (and Claude).
      setReplyError(err instanceof ApiError ? err.message : 'Alisa couldn’t reply. Try again.');
    } finally {
      clearTimeout(typingTimer);
      setWaiting(false);
      replying.current = false;
    }
    // Anything sent while Alisa was answering gets its own reply.
    if (ok && alive.current) replyIfUnanswered();
  }, [applyServer, follow, replyIfUnanswered]);

  const scheduleReply = useCallback(
    (delay = REPLY_DELAY_MS) => {
      clearTimeout(replyTimer.current);
      if (alive.current) replyTimer.current = setTimeout(runReply, delay);
    },
    [runReply],
  );
  scheduleReplyRef.current = scheduleReply;

  // ---- Loading ------------------------------------------------------------

  useEffect(() => {
    alive.current = true;
    Promise.all([api.chat(), api.stories()])
      .then(([c, s]) => {
        if (!alive.current) return;
        const { messages: list, upcoming, ...rest } = c;
        setChat(rest);
        fetchedAt.current = Date.now();
        update(() => list);
        setStories(s.stories);
        // Pick up where things were: Alisa still typing, or a message still waiting for her.
        if (upcoming.length) follow(upcoming);
        else if (needsReply(list)) scheduleReply(300);
      })
      .catch((err) => alive.current && setLoadError(err instanceof ApiError ? err.message : 'Couldn’t load the chat.'));

    const refreshStories = () => api.stories().then((s) => alive.current && setStories(s.stories)).catch(() => {});
    // Fresh photo links for a tab that's been open (or in the background) a while. Only while
    // Alisa isn't mid-reply: her own fetches already bring fresh links then.
    const refreshIfStale = () => {
      if (document.hidden || Date.now() - fetchedAt.current < STALE_MS) return;
      refreshStories();
      if (replying.current || queuedRef.current) return;
      fetchedAt.current = Date.now();
      api
        .chat()
        .then((c) => alive.current && !replying.current && !queuedRef.current && applyServer(c.messages))
        .catch(() => {});
    };
    const every5min = setInterval(() => {
      refreshStories();
      refreshIfStale();
    }, 5 * 60_000);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      alive.current = false;
      clearInterval(every5min);
      document.removeEventListener('visibilitychange', refreshIfStale);
      clearTimeout(replyTimer.current);
      clearTimeout(dueTimer.current);
      clearTimeout(pauseTimer.current);
    };
  }, [scheduleReply, follow, applyServer, update]);

  // ---- Sending --------------------------------------------------------------

  const addTemp = (partial: Partial<UiMessage>): UiMessage => {
    const temp: UiMessage = {
      id: nextTempId.current--,
      sender: 'user',
      kind: 'text',
      text: null,
      createdAt: new Date().toISOString(),
      readAt: null,
      heartByUser: false,
      heartByAi: false,
      photo: null,
      story: null,
      replyTo: null,
      pending: 'sending',
      ...partial,
    };
    setSeenNow(false);
    setReplyError(null);
    onSendRef.current?.();
    update((cur) => [...cur, temp]);
    return temp;
  };

  /** Sends a message shown optimistically as `temp`; resolves to whether it went through. */
  const deliver = async (temp: UiMessage, send: () => Promise<{ message: UiMessage }>) => {
    const attempt = async () => {
      update((cur) => cur.map((m) => (m.id === temp.id ? { ...m, pending: 'sending' } : m)));
      try {
        const { message } = await send();
        retryPayload.current.delete(temp.id);
        // The photo now comes from the server; the local preview isn't needed any more.
        if (temp.photo?.url?.startsWith('blob:')) URL.revokeObjectURL(temp.photo.url);
        update((cur) => cur.map((m) => (m.id === temp.id ? message : m)));
        scheduleReply();
        return true;
      } catch {
        update((cur) => cur.map((m) => (m.id === temp.id ? { ...m, pending: 'failed' } : m)));
        return false;
      }
    };
    retryPayload.current.set(temp.id, attempt);
    return attempt();
  };

  const sendText = (value: string, quoted?: UiMessage | null) => {
    const temp = addTemp({ kind: 'text', text: value, replyTo: quoted ? quoteOf(quoted) : null });
    return deliver(temp, () => api.sendText(value, quoted?.id));
  };

  const sendPhoto = (image: PreparedImage, mode: PhotoMode, quoted?: UiMessage | null) => {
    const temp = addTemp({
      kind: 'photo',
      replyTo: quoted ? quoteOf(quoted) : null,
      photo: {
        mode,
        url: mode === 'keep' ? image.url : null,
        width: image.width,
        height: image.height,
        viewCount: 0,
        maxViews: mode === 'once' ? 1 : mode === 'replay' ? 2 : null,
      },
    });
    // Only a kept photo shows its preview in the chat while sending.
    if (mode !== 'keep') URL.revokeObjectURL(image.url);
    return deliver(temp, () => api.sendPhoto(image.blob, mode, quoted?.id));
  };

  const retry = useCallback((m: UiMessage) => void retryPayload.current.get(m.id)?.(), []);

  // ---- Hearts and photos ----------------------------------------------------

  const setHeart = useCallback(
    (id: number, on: boolean) => {
      update((cur) => cur.map((x) => (x.id === id ? { ...x, heartByUser: on } : x)));
      api.heart(id, on).catch(() => update((cur) => cur.map((x) => (x.id === id ? { ...x, heartByUser: !on } : x))));
    },
    [update],
  );

  /** Uses up one view of a disappearing photo Alisa sent; null (with the error shown) if it can't open. */
  const openPhoto = useCallback(
    async (m: UiMessage): Promise<OpenPhotoDTO | null> => {
      try {
        const opened = await api.openPhoto(m.id);
        update((cur) =>
          cur.map((x) => (x.id === m.id && x.photo ? { ...x, photo: { ...x.photo, viewCount: opened.viewCount } } : x)),
        );
        return opened;
      } catch (err) {
        setReplyError(err instanceof ApiError ? err.message : 'That photo couldn’t be opened.');
        api.chat().then((c) => alive.current && applyServer(c.messages)).catch(() => {});
        return null;
      }
    },
    [update, applyServer],
  );

  // ---- Stories --------------------------------------------------------------

  // Fetch story photos as soon as the list arrives so they're ready by the time someone taps
  // the ring, instead of loading onto a black screen. One at a time, the first unseen story
  // first, so on a slow connection the one they'll see first isn't sharing the bandwidth.
  useEffect(() => {
    let cancelled = false;
    const urls = [...stories.filter((s) => !s.seen), ...stories.filter((s) => s.seen)]
      .map((s) => (s.kind === 'photo' ? s.mediaUrl : null))
      .filter((u): u is string => !!u);
    // Links are re-signed hourly; drop pictures kept for links no story uses any more.
    forgetPreloadsExcept(urls);
    (async () => {
      for (const url of urls) {
        if (cancelled) return;
        await preloadImage(url);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stories.map((s) => s.mediaUrl).join()]);

  const markSeen = (story: StoryDTO) => {
    if (story.seen) return;
    setStories((cur) => cur.map((s) => (s.id === story.id ? { ...s, seen: true } : s)));
    api.viewStory(story.id).catch(() => {});
  };
  const likeStory = (story: StoryDTO, on: boolean) => {
    setStories((cur) => cur.map((s) => (s.id === story.id ? { ...s, liked: on } : s)));
    api.likeStory(story.id, on).catch(() => {});
  };
  const replyToStory = async (story: StoryDTO, value: string) => {
    const temp = addTemp({
      kind: 'story_reply',
      text: value,
      story: { id: story.id, kind: story.kind, caption: story.caption, bg: story.bg, thumbUrl: story.mediaUrl, available: true },
    });
    // The story viewer says "Couldn't send" instead of "Sent"; the reply stays in the chat to retry.
    if (!(await deliver(temp, () => api.replyToStory(story.id, value)))) throw new Error('Couldn’t send');
  };

  const deleteChat = async () => {
    const fresh = await api.deleteChat();
    clearTimeout(replyTimer.current);
    follow([]);
    setReplyError(null);
    setSeenNow(false);
    update(() => fresh.messages);
  };

  return {
    chat,
    loadError,
    messages,
    stories,
    // Waiting for the reply, or her next bubble is still due (with a short pause between bubbles).
    typing: waiting || (queued && !paused),
    seenNow,
    replyError,
    showError: setReplyError,
    runReply,
    sendText,
    sendPhoto,
    retry,
    setHeart,
    openPhoto,
    markSeen,
    likeStory,
    replyToStory,
    deleteChat,
  };
}
