import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ChatDTO, OpenPhotoDTO, PhotoMode, StoryDTO } from '../../shared/types';
import { api, ApiError } from '../api';
import { Avatar, type RingState } from '../components/Avatar';
import { CameraSheet } from '../components/CameraSheet';
import { IconCamera, IconImage, IconInfo } from '../components/Icons';
import { InfoSheet } from '../components/InfoSheet';
import { MessageItem } from '../components/MessageItem';
import { Lightbox, PhotoViewer } from '../components/PhotoViewer';
import { SendPhotoSheet } from '../components/SendPhotoSheet';
import { StoryViewer } from '../components/StoryViewer';
import { prepareImage, type PreparedImage } from '../lib/image';
import { buildThread, type UiMessage } from '../lib/thread';
import { seenLabel } from '../lib/time';

/** How long to wait after the user's last message before Alisa answers, so bursts get one reply. */
const REPLY_DELAY_MS = 1200;
/** Pause between Alisa's bubbles when she sends several. */
const BUBBLE_GAP_MS = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ChatPage() {
  const [chat, setChat] = useState<Omit<ChatDTO, 'messages'> | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [stories, setStories] = useState<StoryDTO[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [typing, setTyping] = useState(false);
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

  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<UiMessage[]>([]);
  const replyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const replying = useRef(false);
  const nextTempId = useRef(-1);
  const retryPayload = useRef(new Map<number, () => Promise<void>>());
  messagesRef.current = messages;

  const aiConnected = chat?.aiConnected ?? true;

  // ---- Alisa's replies -------------------------------------------------------

  const runReply = useCallback(async () => {
    if (replying.current) return;
    const last = messagesRef.current.at(-1);
    if (!last || last.sender !== 'user' || last.pending) return;
    replying.current = true;
    setReplyError(null);
    setSeenNow(true);
    const typingTimer = setTimeout(() => setTyping(true), 500);
    try {
      const before = new Set(messagesRef.current.map((m) => m.id));
      const res = await api.reply();
      clearTimeout(typingTimer);
      setTyping(true);
      const fresh = res.messages.filter((m) => !before.has(m.id) && m.sender === 'ai');
      const queued = fresh.slice(1).map((m) => m.id);
      setHidden(new Set(queued));
      // Keep anything still uploading, or delivered after the server took its snapshot.
      const newest = Math.max(0, ...res.messages.map((m) => m.id));
      const merged = [...res.messages, ...messagesRef.current.filter((m) => m.pending || m.id > newest)];
      messagesRef.current = merged;
      setMessages(merged);
      for (const id of queued) {
        await sleep(BUBBLE_GAP_MS);
        setHidden((h) => {
          const n = new Set(h);
          n.delete(id);
          return n;
        });
      }
    } catch (err) {
      setReplyError(err instanceof ApiError ? err.message : 'Alisa couldn’t reply. Try again.');
    } finally {
      clearTimeout(typingTimer);
      setTyping(false);
      replying.current = false;
      // Anything sent while Alisa was answering gets its own reply.
      const latest = messagesRef.current.at(-1);
      if (latest && latest.sender === 'user' && !latest.pending && !latest.readAt) scheduleReply(REPLY_DELAY_MS);
    }
  }, []);

  const scheduleReply = useCallback(
    (delay = REPLY_DELAY_MS) => {
      clearTimeout(replyTimer.current);
      replyTimer.current = setTimeout(runReply, delay);
    },
    [runReply],
  );

  // ---- Loading ------------------------------------------------------------

  useEffect(() => {
    let alive = true;
    Promise.all([api.chat(), api.stories()])
      .then(([c, s]) => {
        if (!alive) return;
        const { messages: list, ...rest } = c;
        setChat(rest);
        setMessages(list);
        setStories(s.stories);
        if (list.at(-1)?.sender === 'user') {
          messagesRef.current = list;
          scheduleReply(300);
        }
      })
      .catch((err) => alive && setLoadError(err instanceof ApiError ? err.message : 'Couldn’t load the chat.'));
    const refreshStories = setInterval(() => api.stories().then((s) => alive && setStories(s.stories)).catch(() => {}), 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(refreshStories);
      clearTimeout(replyTimer.current);
    };
  }, [scheduleReply]);

  // ---- Scrolling ------------------------------------------------------------

  const visible = useMemo(() => messages.filter((m) => !hidden.has(m.id)), [messages, hidden]);
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || visible.length === 0) return;
    el.scrollTo({ top: el.scrollHeight, behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [visible.length, typing, replyError]);

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
      pending: 'sending',
      ...partial,
    };
    setSeenNow(false);
    setReplyError(null);
    setMessages((cur) => [...cur, temp]);
    return temp;
  };

  const deliver = async (temp: UiMessage, send: () => Promise<{ message: UiMessage }>) => {
    const attempt = async () => {
      setMessages((cur) => cur.map((m) => (m.id === temp.id ? { ...m, pending: 'sending' } : m)));
      try {
        const { message } = await send();
        retryPayload.current.delete(temp.id);
        setMessages((cur) => cur.map((m) => (m.id === temp.id ? message : m)));
        messagesRef.current = messagesRef.current.map((m) => (m.id === temp.id ? message : m));
        scheduleReply();
      } catch {
        setMessages((cur) => cur.map((m) => (m.id === temp.id ? { ...m, pending: 'failed' } : m)));
      }
    };
    retryPayload.current.set(temp.id, attempt);
    await attempt();
  };

  const sendText = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    const temp = addTemp({ kind: 'text', text: value });
    deliver(temp, () => api.sendText(value));
  };

  const sendPhoto = (image: PreparedImage, mode: PhotoMode) => {
    setSendSheet(null);
    const temp = addTemp({
      kind: 'photo',
      photo: {
        mode,
        url: mode === 'keep' ? image.url : null,
        width: image.width,
        height: image.height,
        viewCount: 0,
        maxViews: mode === 'once' ? 1 : mode === 'replay' ? 2 : null,
      },
    });
    deliver(temp, () => api.sendPhoto(image.blob, mode));
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
      api.chat().then((c) => setMessages((cur) => [...c.messages, ...cur.filter((x) => x.pending)])).catch(() => {});
    }
  };

  // ---- Stories --------------------------------------------------------------

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
    await deliver(temp, () => api.replyToStory(story.id, value));
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
  const rows = buildThread(visible);
  const last = visible.at(-1);
  const showSeen = !typing && last?.sender === 'user' && !last.pending && (last.readAt || seenNow);

  return (
    <div className="phone">
      <header className="chat-header">
        <div className="header-avatar">
          <Avatar
            persona={persona}
            size={40}
            ring={ring}
            active
            onClick={ring === 'none' ? () => setInfo(true) : openStories}
            label={ring === 'none' ? `About ${persona.name}` : `View ${persona.name}’s story`}
          />
        </div>
        <button type="button" className="header-title" onClick={() => setInfo(true)}>
          <span className="header-name">{persona.name}</span>
          <span className="header-status">{typing ? 'typing…' : aiConnected ? 'Active now' : 'Offline'}</span>
        </button>
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
          <p>{persona.handle} · DM-me</p>
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
            />
          ),
        )}

        {typing && (
          <div className="msg msg-theirs" style={{ marginTop: 10 }}>
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

      {!aiConnected && (
        <p className="offline-banner">
          {persona.name} isn’t connected yet. Add <code>ANTHROPIC_API_KEY</code> on the server to get replies.
        </p>
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
            id="composer-input"
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
            setInfo(false);
            setHidden(new Set());
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
