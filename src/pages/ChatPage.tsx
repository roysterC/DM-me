import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatDTO, OpenPhotoDTO, PhotoMode, ReplyRefDTO, StoryDTO } from '../../shared/types';
import { api, ApiError } from '../api';
import { Avatar, type RingState } from '../components/Avatar';
import { CameraSheet } from '../components/CameraSheet';
import { IconCamera, IconClose, IconImage, IconInfo } from '../components/Icons';
import { InfoSheet } from '../components/InfoSheet';
import { MessageItem } from '../components/MessageItem';
import { Lightbox, PhotoViewer } from '../components/PhotoViewer';
import { SendPhotoSheet } from '../components/SendPhotoSheet';
import { StoryViewer } from '../components/StoryViewer';
import { prepareImage, type PreparedImage } from '../lib/image';
import { forgetPreloadsExcept, preloadImage } from '../lib/preload';
import { buildThread, mergeServer, type UiMessage } from '../lib/thread';
import { seenLabel } from '../lib/time';
import { useScrollGradient } from '../lib/useScrollGradient';
import { useThreadGestures } from '../lib/useThreadGestures';

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
/** Within this many pixels of the bottom counts as reading the latest messages. */
const NEAR_BOTTOM_PX = 80;

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/**
 * Whether Alisa owes a reply: something the visitor sent that she hasn't read, or
 * (after a failed attempt) a last message from them she never answered. With her
 * bubbles landing over time, the visitor's message isn't always the last one shown.
 */
/** What a reply shows of the message it quotes. */
const quoteOf = (m: UiMessage): ReplyRefDTO => ({
  id: m.id,
  sender: m.sender,
  text: m.kind === 'photo' ? null : m.text,
  photo: m.kind === 'photo',
});

function needsReply(list: UiMessage[], queued = false): boolean {
  if (list.some((m) => m.sender === 'user' && !m.pending && !m.readAt)) return true;
  // While her bubbles are still due, the visitor's message shows last but is already answered.
  if (queued) return false;
  const last = list.at(-1);
  return !!last && last.sender === 'user' && !last.pending;
}

export function ChatPage() {
  const [chat, setChat] = useState<Omit<ChatDTO, 'messages' | 'upcoming'> | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [stories, setStories] = useState<StoryDTO[]>([]);
  // Typing shows while the reply is being written, and while her bubbles are still due.
  const [waiting, setWaiting] = useState(false);
  const [queued, setQueued] = useState(false);
  const [paused, setPaused] = useState(false);
  const typing = waiting || (queued && !paused);
  const [seenNow, setSeenNow] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');

  const [camera, setCamera] = useState(false);
  const [sendSheet, setSendSheet] = useState<{ image: PreparedImage; defaultMode: PhotoMode } | null>(null);
  const [storyAt, setStoryAt] = useState<number | null>(null);
  const [viewer, setViewer] = useState<{ message: UiMessage; opened: OpenPhotoDTO } | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  const [info, setInfo] = useState(false);
  const [replyingTo, setReplyingTo] = useState<UiMessage | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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
  messagesRef.current = messages;

  const aiConnected = chat?.aiConnected ?? true;

  // ---- Alisa's replies -------------------------------------------------------

  /** Takes the server's view of the chat, keeping what the visitor sent since (or is still sending). */
  const applyServer = useCallback((list: UiMessage[]) => {
    fetchedAt.current = Date.now();
    const merged = mergeServer(list, messagesRef.current);
    messagesRef.current = merged;
    setMessages(merged);
  }, []);

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
        messagesRef.current = list;
        setMessages(list);
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
  }, [scheduleReply, follow, applyServer]);

  // ---- Scrolling ------------------------------------------------------------

  // Whether new messages should scroll into view: only while the visitor is at the bottom (or
  // has just sent something), never while they're reading further up.
  const pinned = useRef(true);
  // Set during our own smooth scroll down, whose in-between positions aren't the visitor's doing.
  const autoScrolling = useRef(false);
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || messages.length === 0) return;
    if (!firstScroll.current && !pinned.current) return;
    const behavior = firstScroll.current ? 'auto' : scrollBehavior();
    autoScrolling.current = behavior === 'smooth' && el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    el.scrollTo({ top: el.scrollHeight, behavior });
    firstScroll.current = false;
  }, [messages.length, typing, replyError]);

  // The top and bottom bars float over the chat; leave room for them, and stay at the
  // bottom when the bottom bar grows (a reply preview opening, say).
  const loaded = chat !== null;
  useLayoutEffect(() => {
    const phone = phoneRef.current;
    const thread = listRef.current;
    const header = headerRef.current;
    const bottom = bottomRef.current;
    if (!phone || !thread || !header || !bottom) return;
    const measure = () => {
      const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
      phone.style.setProperty('--top-h', `${header.offsetHeight}px`);
      phone.style.setProperty('--bottom-h', `${bottom.offsetHeight}px`);
      if (atBottom) thread.scrollTop = thread.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(bottom);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const distance = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    const onScroll = () => {
      if (autoScrolling.current) {
        // Done once it reaches the bottom, or shortly after it stops moving (the visitor may
        // have scrolled away mid-way, so look again then).
        clearTimeout(settle);
        if (distance() < 2) autoScrolling.current = false;
        else
          settle = setTimeout(() => {
            autoScrolling.current = false;
            pinned.current = distance() < NEAR_BOTTOM_PX;
          }, 200);
        return;
      }
      pinned.current = distance() < NEAR_BOTTOM_PX;
    };
    thread.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      thread.removeEventListener('scroll', onScroll);
      clearTimeout(settle);
    };
  }, [loaded]);

  useScrollGradient(listRef, messages);

  // ---- Replying to a message ---------------------------------------------------

  const startReply = useCallback((id: number) => {
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m || m.pending || m.id <= 0) return;
    setReplyingTo(m);
    inputRef.current?.focus();
  }, []);
  useThreadGestures(listRef, startReply, loaded);

  /** Scrolls to a quoted message and makes it pulse briefly so it's easy to spot. */
  const jumpTo = (id: number) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1400);
  };

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
    // Sending something always shows it, even from further up the chat.
    pinned.current = true;
    setMessages((cur) => [...cur, temp]);
    return temp;
  };

  /** Sends a message shown optimistically as `temp`; resolves to whether it went through. */
  const deliver = async (temp: UiMessage, send: () => Promise<{ message: UiMessage }>) => {
    const attempt = async () => {
      setMessages((cur) => cur.map((m) => (m.id === temp.id ? { ...m, pending: 'sending' } : m)));
      try {
        const { message } = await send();
        retryPayload.current.delete(temp.id);
        // The photo now comes from the server; the local preview isn't needed any more.
        if (temp.photo?.url?.startsWith('blob:')) URL.revokeObjectURL(temp.photo.url);
        setMessages((cur) => cur.map((m) => (m.id === temp.id ? message : m)));
        messagesRef.current = messagesRef.current.map((m) => (m.id === temp.id ? message : m));
        scheduleReply();
        return true;
      } catch {
        setMessages((cur) => cur.map((m) => (m.id === temp.id ? { ...m, pending: 'failed' } : m)));
        return false;
      }
    };
    retryPayload.current.set(temp.id, attempt);
    return attempt();
  };

  const sendText = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    const quoted = replyingTo;
    setReplyingTo(null);
    const temp = addTemp({ kind: 'text', text: value, replyTo: quoted && quoteOf(quoted) });
    deliver(temp, () => api.sendText(value, quoted?.id));
  };

  const sendPhoto = (image: PreparedImage, mode: PhotoMode) => {
    setSendSheet(null);
    const quoted = replyingTo;
    setReplyingTo(null);
    const temp = addTemp({
      kind: 'photo',
      replyTo: quoted && quoteOf(quoted),
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
    deliver(temp, () => api.sendPhoto(image.blob, mode, quoted?.id));
  };

  const pickFromLibrary = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    try {
      setSendSheet({ image: await prepareImage(file), defaultMode: 'keep' });
    } catch {
      setReplyError('That photo couldn’t be opened. Try a JPEG or PNG.');
    }
  };

  // ---- Hearts and photos ----------------------------------------------------

  const toggleHeart = (m: UiMessage) => {
    const on = !m.heartByUser;
    setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, heartByUser: on } : x)));
    setViewer((v) => (v && v.message.id === m.id ? { ...v, message: { ...v.message, heartByUser: on } } : v));
    api.heart(m.id, on).catch(() =>
      setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, heartByUser: !on } : x))),
    );
  };

  const openEphemeral = async (m: UiMessage) => {
    try {
      const opened = await api.openPhoto(m.id);
      setMessages((cur) =>
        cur.map((x) => (x.id === m.id && x.photo ? { ...x, photo: { ...x.photo, viewCount: opened.viewCount } } : x)),
      );
      setViewer({ message: m, opened });
    } catch (err) {
      setReplyError(err instanceof ApiError ? err.message : 'That photo couldn’t be opened.');
      api.chat().then((c) => alive.current && applyServer(c.messages)).catch(() => {});
    }
  };

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

  const ring: RingState = stories.length === 0 ? 'none' : stories.every((s) => s.seen) ? 'seen' : 'unseen';
  const openStories = () => {
    if (stories.length === 0) return;
    const firstUnseen = stories.findIndex((s) => !s.seen);
    setInfo(false);
    setStoryAt(firstUnseen === -1 ? 0 : firstUnseen);
  };
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

  // ---- Render ----------------------------------------------------------------

  if (loadError) {
    return (
      <div className="phone center-state">
        <p>{loadError}</p>
        <button type="button" className="primary-btn" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!chat) return <div className="phone center-state" aria-busy="true" />;

  const persona = chat.persona;
  const rows = buildThread(messages);
  const last = messages.at(-1);
  const showSeen = !typing && last?.sender === 'user' && !last.pending && (last.readAt || seenNow);

  return (
    <div className="phone" ref={phoneRef}>
      {/* Messages blur and darken as they slide under the top bar (see .top-fade). */}
      <div className="top-fade" aria-hidden="true">
        <span className="blur-top" />
        <span className="blur-mid" />
        <span className="blur-low" />
        <span className="dim" />
      </div>
      <header className="chat-header floating" ref={headerRef}>
        <div className="header-avatar">
          <Avatar
            persona={persona}
            size={34}
            ring={ring}
            active
            onClick={ring === 'none' ? () => setInfo(true) : openStories}
            label={ring === 'none' ? `About ${persona.name}` : `View ${persona.name}’s story`}
          />
        </div>
        {/* Just a label: only the profile photo and the info button respond to taps. */}
        <div className="header-title">
          <span className="header-name">{persona.name}</span>
          <span className="header-status">{typing ? 'typing…' : aiConnected ? 'Active now' : 'Offline'}</span>
        </div>
        <button type="button" className="icon-btn" onClick={() => setInfo(true)} aria-label={`About ${persona.name}`}>
          <IconInfo size={26} />
        </button>
      </header>

      <div className="thread" ref={listRef}>
        <div className="intro">
          <Avatar
            persona={persona}
            size={96}
            ring={ring}
            onClick={ring === 'none' ? undefined : openStories}
            label={`View ${persona.name}’s story`}
          />
          <h1>{persona.name}</h1>
          <p>{persona.handle}</p>
          <button type="button" className="soft-btn" onClick={() => setInfo(true)}>
            View profile
          </button>
        </div>

        {rows.map((row) =>
          row.type === 'separator' ? (
            <div key={row.key} className="separator">
              {row.label}
            </div>
          ) : (
            <MessageItem
              key={row.key}
              message={row.message}
              persona={persona}
              joinPrev={row.joinPrev}
              joinNext={row.joinNext}
              showAvatar={row.showAvatar && !(typing && row.message.id === last?.id)}
              onToggleHeart={toggleHeart}
              onOpenEphemeral={openEphemeral}
              onOpenKept={(m) => m.photo?.url && setLightbox({ url: m.photo.url, alt: m.sender === 'user' ? 'Photo you sent' : `Photo from ${persona.name}` })}
              onRetry={(m) => retryPayload.current.get(m.id)?.()}
              onReply={(m) => startReply(m.id)}
              onJumpTo={jumpTo}
            />
          ),
        )}

        {typing && (
          <div className="msg msg-theirs" style={{ marginTop: 12 }}>
            <div className="msg-avatar">
              <Avatar persona={persona} size={28} />
            </div>
            <div className="typing" role="status" aria-label={`${persona.name} is typing`}>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}

        {showSeen && <div className="seen">{last.readAt ? seenLabel(last.readAt) : 'Seen just now'}</div>}

        {replyError && (
          <div className="reply-error" role="alert">
            {replyError}
            {aiConnected && (
              <button type="button" onClick={() => runReply()}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <div className="bottom-bar" ref={bottomRef}>
        {!aiConnected && (
          <p className="offline-banner">
            {persona.name} isn’t connected yet. Add <code>ANTHROPIC_API_KEY</code> on the server to get replies.
          </p>
        )}

        {replyingTo && (
          <div className="reply-bar">
            <div className="reply-bar-text">
              <span className="reply-bar-title">Replying to {replyingTo.sender === 'ai' ? persona.name : 'yourself'}</span>
              <span className="reply-bar-snippet">{replyingTo.kind === 'photo' ? 'Photo' : replyingTo.text}</span>
            </div>
            <button type="button" className="icon-btn" onClick={() => setReplyingTo(null)} aria-label="Cancel reply">
              <IconClose size={20} />
            </button>
          </div>
        )}

        <form className="composer" onSubmit={sendText}>
          <div className="composer-pill">
            <button type="button" className="camera-btn" onClick={() => setCamera(true)} aria-label="Camera">
              <span>
                <IconCamera size={20} strokeWidth={2} />
              </span>
            </button>
            <label className="sr-only" htmlFor="composer-input">
              Message {persona.name}
            </label>
            <input
              ref={inputRef}
              id="composer-input"
              onKeyDown={(e) => e.key === 'Escape' && setReplyingTo(null)}
              placeholder="Message..."
              autoComplete="off"
              enterKeyHint="send"
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {text.trim() ? (
              <button type="submit" className="send-text">
                Send
              </button>
            ) : (
              <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Send a photo from your library">
                <IconImage size={24} />
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickFromLibrary(e.target.files?.[0])} />
          </div>
        </form>
      </div>

      {camera && (
        <CameraSheet
          onClose={() => setCamera(false)}
          onCaptured={(image) => {
            setCamera(false);
            setSendSheet({ image, defaultMode: 'once' });
          }}
        />
      )}
      {sendSheet && (
        <SendPhotoSheet
          image={sendSheet.image}
          persona={persona}
          defaultMode={sendSheet.defaultMode}
          onCancel={() => {
            URL.revokeObjectURL(sendSheet.image.url);
            setSendSheet(null);
          }}
          onSend={(mode) => sendPhoto(sendSheet.image, mode)}
        />
      )}
      {storyAt !== null && (
        <StoryViewer
          stories={stories}
          startIndex={storyAt}
          persona={persona}
          onClose={() => setStoryAt(null)}
          onSeen={markSeen}
          onLike={likeStory}
          onReply={replyToStory}
        />
      )}
      {viewer && (
        <PhotoViewer
          message={viewer.message}
          opened={viewer.opened}
          persona={persona}
          onClose={() => setViewer(null)}
          onToggleHeart={() => toggleHeart(viewer.message)}
          onReply={(value) => {
            const temp = addTemp({ kind: 'text', text: value });
            deliver(temp, () => api.sendText(value));
          }}
        />
      )}
      {lightbox && <Lightbox url={lightbox.url} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
      {info && (
        <InfoSheet
          persona={persona}
          ring={ring}
          onViewStory={openStories}
          onClose={() => setInfo(false)}
          onDeleteChat={async () => {
            const fresh = await api.deleteChat();
            clearTimeout(replyTimer.current);
            follow([]);
            setReplyingTo(null);
            setInfo(false);
            setReplyError(null);
            setSeenNow(false);
            messagesRef.current = fresh.messages;
            setMessages(fresh.messages);
          }}
        />
      )}
    </div>
  );
}
