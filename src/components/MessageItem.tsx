import { useRef } from 'react';
import type { PersonaDTO, ReplyRefDTO } from '../../shared/types';
import { bubbleRadius, type UiMessage } from '../lib/thread';
import { clockTime } from '../lib/time';
import { Avatar } from './Avatar';
import { IconHeart, IconOnce, IconOpened, IconReplay, IconReply } from './Icons';

interface Props {
  message: UiMessage;
  persona: PersonaDTO;
  joinPrev: boolean;
  joinNext: boolean;
  showAvatar: boolean;
  onToggleHeart: (m: UiMessage) => void;
  onOpenEphemeral: (m: UiMessage) => void;
  onOpenKept: (m: UiMessage) => void;
  onRetry: (m: UiMessage) => void;
  onReply: (m: UiMessage) => void;
  /** Scrolls to the message a reply quotes. */
  onJumpTo: (id: number) => void;
}

export function MessageItem({ message: m, persona, joinPrev, joinNext, showAvatar, ...on }: Props) {
  const mine = m.sender === 'user';
  const radius = bubbleRadius(m.sender, joinPrev, joinNext);
  const lastTap = useRef(0);

  // Double-tap (or double-click) one of Alisa's messages to heart it, like Instagram.
  const tapToHeart = () => {
    if (mine || m.pending) return;
    const now = Date.now();
    if (now - lastTap.current < 320) {
      on.onToggleHeart(m);
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  };

  const content = renderContent(m, radius, on);
  const heart = mine ? m.heartByAi : m.heartByUser;
  const replyButton = m.id > 0 && !m.pending && (
    <button type="button" className="msg-reply-btn" onClick={() => on.onReply(m)} aria-label="Reply">
      <IconReply size={18} />
    </button>
  );

  return (
    <div
      id={`msg-${m.id}`}
      data-msg-id={m.id}
      className={`msg ${mine ? 'msg-mine' : 'msg-theirs'}`}
      style={{ marginTop: joinPrev && !m.replyTo ? 2 : 10 }}
    >
      <span className="msg-swipe-icon" aria-hidden="true">
        <IconReply size={18} />
      </span>
      {!mine && (
        <div className="msg-avatar">{showAvatar && <Avatar persona={persona} size={28} />}</div>
      )}
      {mine && replyButton}
      <div className="msg-col" onClick={tapToHeart}>
        {m.kind === 'story_reply' && m.story && <StoryQuote story={m.story} />}
        {m.replyTo && <ReplyQuote quoted={m.replyTo} mine={mine} name={persona.name} onJump={on.onJumpTo} />}
        {content}
        {heart && (
          <button
            type="button"
            className="msg-reaction"
            onClick={mine ? undefined : () => on.onToggleHeart(m)}
            aria-label={mine ? `${persona.name} hearted this` : 'Remove your heart'}
            disabled={mine}
          >
            <IconHeart filled size={13} />
          </button>
        )}
        {m.pending === 'failed' && (
          <button type="button" className="msg-failed" onClick={() => on.onRetry(m)}>
            Not sent. Tap to retry.
          </button>
        )}
      </div>
      {!mine && replyButton}
      {/* Slides into view when the chat is swiped left. */}
      <time className="msg-time" dateTime={m.createdAt} aria-hidden="true">
        {clockTime(m.createdAt)}
      </time>
    </div>
  );
}

/** "You replied to Alisa" and a faded copy of what was quoted; tap it to jump there. */
function ReplyQuote(props: { quoted: ReplyRefDTO; mine: boolean; name: string; onJump: (id: number) => void }) {
  const { quoted, mine, name, onJump } = props;
  const label = mine
    ? quoted.sender === 'user'
      ? 'You replied to yourself'
      : `You replied to ${name}`
    : quoted.sender === 'user'
      ? `${name} replied to you`
      : `${name} replied`;
  const preview = quoted.photo ? 'Photo' : (quoted.text ?? '');
  return (
    <div className="reply-quote">
      <span className="reply-quote-label">{label}</span>
      <button
        type="button"
        className="reply-quote-text"
        onClick={(e) => {
          e.stopPropagation();
          onJump(quoted.id);
        }}
        aria-label={`${label}: ${preview}. Show the original message`}
      >
        <span>{preview}</span>
      </button>
    </div>
  );
}

function renderContent(m: UiMessage, radius: string, on: Pick<Props, 'onOpenEphemeral' | 'onOpenKept'>) {
  const mine = m.sender === 'user';
  const style = { borderRadius: radius };

  if (m.kind !== 'photo' || !m.photo) {
    return (
      <div className={`bubble ${mine ? 'bubble-sent sent-fill' : 'bubble-recv'}`} style={style}>
        {m.text}
      </div>
    );
  }

  const p = m.photo;
  if (p.mode === 'keep' && !p.url) {
    return (
      <div className="photo-gone" style={style}>
        Photo unavailable
      </div>
    );
  }
  if (p.mode === 'keep') {
    const ratio = p.width && p.height ? `${p.width} / ${p.height}` : '4 / 5';
    return (
      <button type="button" className="photo-kept" style={{ ...style, aspectRatio: ratio }} onClick={() => on.onOpenKept(m)} aria-label="Open photo">
        <img src={p.url!} alt={mine ? 'Photo you sent' : 'Photo from Alisa'} loading="lazy" />
      </button>
    );
  }

  const ModeIcon = p.mode === 'once' ? IconOnce : IconReplay;
  if (mine) {
    // Your own view-once photo: you can't reopen it, you only see whether Alisa has.
    const opened = p.viewCount > 0;
    const status = m.pending === 'sending' ? 'Sending…' : m.pending === 'failed' ? 'Not sent' : opened ? 'Opened' : 'Delivered';
    return (
      <div className={`eph ${opened ? 'eph-spent' : 'eph-sent sent-fill'}`} style={style}>
        <span className="eph-icon">
          <ModeIcon size={18} />
        </span>
        <span className="eph-text">
          <span className="eph-title">Photo</span>
          <span className="eph-sub">{status}</span>
        </span>
      </div>
    );
  }

  const canOpen = p.maxViews != null && p.viewCount < p.maxViews;
  if (!canOpen) {
    return (
      <div className="eph eph-spent" style={style}>
        <span className="eph-icon">
          <IconOpened size={18} />
        </span>
        <span className="eph-text">
          <span className="eph-title">Photo</span>
          <span className="eph-sub">Opened</span>
        </span>
      </div>
    );
  }
  const sub = p.viewCount === 0 ? 'Tap to view' : 'Tap to replay';
  return (
    <button type="button" className="eph eph-recv" style={style} onClick={() => on.onOpenEphemeral(m)} aria-label={`Photo from Alisa. ${sub}`}>
      <span className="eph-icon eph-icon-live">
        <ModeIcon size={18} />
      </span>
      <span className="eph-text">
        <span className="eph-title">Photo</span>
        <span className="eph-sub">{sub}</span>
      </span>
    </button>
  );
}

function StoryQuote({ story }: { story: NonNullable<UiMessage['story']> }) {
  return (
    <div className="story-quote">
      <span className="story-quote-label">You replied to their story</span>
      {!story.available ? (
        <div className="story-quote-gone">Story unavailable</div>
      ) : story.kind === 'photo' && story.thumbUrl ? (
        <img className="story-quote-thumb" src={story.thumbUrl} alt={story.caption ?? 'Alisa’s story'} />
      ) : (
        <div className={`story-quote-thumb story-quote-text bg-${story.bg ?? 'violet'}`}>{story.caption}</div>
      )}
    </div>
  );
}
