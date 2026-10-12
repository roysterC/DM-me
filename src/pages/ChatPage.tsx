import { useCallback, useRef, useState } from 'react';
import type { OpenPhotoDTO, PhotoMode } from '../../shared/types';
import { Avatar, type RingState } from '../components/Avatar';
import { CameraSheet } from '../components/CameraSheet';
import { Composer } from '../components/Composer';
import { IconInfo } from '../components/Icons';
import { InfoSheet } from '../components/InfoSheet';
import { MessageItem } from '../components/MessageItem';
import { Lightbox, PhotoViewer } from '../components/PhotoViewer';
import { SendPhotoSheet } from '../components/SendPhotoSheet';
import { StoryViewer } from '../components/StoryViewer';
import { prepareImage, type PreparedImage } from '../lib/image';
import { buildThread, type UiMessage } from '../lib/thread';
import { seenLabel } from '../lib/time';
import { useChat } from '../lib/useChat';
import { scrollBehavior, useChatScroll } from '../lib/useChatScroll';
import { useScrollGradient } from '../lib/useScrollGradient';
import { useThreadGestures } from '../lib/useThreadGestures';

export function ChatPage() {
  const c = useChat({ onSend: () => scroll.pin() });
  const { chat, messages, stories, typing, replyError } = c;

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
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const loaded = chat !== null;
  const aiConnected = chat?.aiConnected ?? true;
  const personaName = chat?.persona.name ?? '';

  const scroll = useChatScroll(
    { phone: phoneRef, thread: listRef, header: headerRef, bottom: bottomRef },
    loaded,
    messages.length === 0,
    [messages.length, typing, replyError],
  );
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
  const jumpTo = useCallback((id: number) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1400);
  }, []);

  // ---- Sending ------------------------------------------------------------------

  /** The message being quote-replied to, if any, cleared as it's sent. */
  const takeQuote = () => {
    const quoted = replyingTo;
    setReplyingTo(null);
    return quoted;
  };

  const pickFromLibrary = async (file: File) => {
    try {
      setSendSheet({ image: await prepareImage(file), defaultMode: 'keep' });
    } catch {
      c.showError('That photo couldn’t be opened. Try a JPEG or PNG.');
    }
  };

  // ---- Hearts and photos (stable, so a new message doesn't re-render the others) ----

  const { setHeart, openPhoto, retry } = c;
  const toggleHeart = useCallback(
    (m: UiMessage) => {
      const on = !(messagesRef.current.find((x) => x.id === m.id) ?? m).heartByUser;
      setHeart(m.id, on);
      setViewer((v) => (v && v.message.id === m.id ? { ...v, message: { ...v.message, heartByUser: on } } : v));
    },
    [setHeart],
  );
  const openEphemeral = useCallback(
    async (m: UiMessage) => {
      const opened = await openPhoto(m);
      if (opened) setViewer({ message: m, opened });
    },
    [openPhoto],
  );
  const openKept = useCallback(
    (m: UiMessage) => {
      if (m.photo?.url) setLightbox({ url: m.photo.url, alt: m.sender === 'user' ? 'Photo you sent' : `Photo from ${personaName}` });
    },
    [personaName],
  );
  const replyTo = useCallback((m: UiMessage) => startReply(m.id), [startReply]);

  // ---- Stories ------------------------------------------------------------------

  const ring: RingState = stories.length === 0 ? 'none' : stories.every((s) => s.seen) ? 'seen' : 'unseen';
  const openStories = () => {
    if (stories.length === 0) return;
    const firstUnseen = stories.findIndex((s) => !s.seen);
    setInfo(false);
    setStoryAt(firstUnseen === -1 ? 0 : firstUnseen);
  };

  // ---- Render ----------------------------------------------------------------

  if (c.loadError) {
    return (
      <div className="phone center-state">
        <p>{c.loadError}</p>
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
  const showSeen = !typing && last?.sender === 'user' && !last.pending && (last.readAt || c.seenNow);

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

      {/* A log: screen readers announce new messages as they arrive. */}
      <div className="thread" ref={listRef} role="log" aria-label={`Messages with ${persona.name}`}>
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
              onOpenKept={openKept}
              onRetry={retry}
              onReply={replyTo}
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
              <button type="button" onClick={() => c.runReply()}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <Composer
        persona={persona}
        aiConnected={aiConnected}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
        onSendText={(value) => c.sendText(value, takeQuote())}
        onCamera={() => setCamera(true)}
        onPickFile={pickFromLibrary}
        barRef={bottomRef}
        inputRef={inputRef}
      />

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
          onSend={(mode) => {
            setSendSheet(null);
            c.sendPhoto(sendSheet.image, mode, takeQuote());
          }}
        />
      )}
      {storyAt !== null && (
        <StoryViewer
          stories={stories}
          startIndex={storyAt}
          persona={persona}
          onClose={() => setStoryAt(null)}
          onSeen={c.markSeen}
          onLike={c.likeStory}
          onReply={c.replyToStory}
        />
      )}
      {viewer && (
        <PhotoViewer
          message={viewer.message}
          opened={viewer.opened}
          persona={persona}
          onClose={() => setViewer(null)}
          onToggleHeart={() => toggleHeart(viewer.message)}
          onReply={(value) => c.sendText(value)}
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
            await c.deleteChat();
            setReplyingTo(null);
            setInfo(false);
          }}
        />
      )}
    </div>
  );
}
