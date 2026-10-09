import { useRef } from 'react';
import type { PersonaDTO } from '../../shared/types';
import { bubbleRadius, type UiMessage } from '../lib/thread';
import { Avatar } from './Avatar';
import { IconHeart, IconOnce, IconOpened, IconReplay } from './Icons';

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
}

export function MessageItem({ message: m, persona, joinPrev, joinNext, showAvatar, ...on }: Props) {
  const mine = m.sender === 'user';
  const radius = bubbleRadius(m.sender, joinPrev, joinNext);
  const lastTap = useRef(0);

  // Double-tap (or double-click) one of Nova's messages to heart it, like Instagram.
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

  return (
    <div className={`msg ${mine ? 'msg-mine' : 'msg-theirs'}`} style={{ marginTop: joinPrev ? 2 : 10 }}>
      {!mine && (
        <div className="msg-avatar">{showAvatar && <Avatar persona={persona} size={28} />}</div>
      )}
      <div className="msg-col" onClick={tapToHeart}>
        {m.kind === 'story_reply' && m.story && <StoryQuote story={m.story} />}
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
    </div>
  );
}

function renderContent(m: UiMessage, radius: string, on: Pick<Props, 'onOpenEphemeral' | 'onOpenKept'>) {
  const mine = m.sender === 'user';
  const style = { borderRadius: radius };

  if (m.kind !== 'photo' || !m.photo) {
    return (
      <div className={`bubble ${mine ? 'bubble-sent' : 'bubble-recv'}`} style={style}>
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
        <img src={p.url!} alt={mine ? 'Photo you sent' : 'Photo from Nova'} loading="lazy" />
      </button>
    );
  }

  const ModeIcon = p.mode === 'once' ? IconOnce : IconReplay;
  if (mine) {
    // Your own view-once photo: you can't reopen it, you only see whether Nova has.
    const opened = p.viewCount > 0;
    const status = m.pending === 'sending' ? 'Sending…' : m.pending === 'failed' ? 'Not sent' : opened ? 'Opened' : 'Delivered';
    return (
      <div className={`eph ${opened ? 'eph-spent' : 'eph-sent'}`} style={style}>
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
    <button type="button" className="eph eph-recv" style={style} onClick={() => on.onOpenEphemeral(m)} aria-label={`Photo from Nova. ${sub}`}>
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
        <img className="story-quote-thumb" src={story.thumbUrl} alt={story.caption ?? 'Nova’s story'} />
      ) : (
        <div className={`story-quote-thumb story-quote-text bg-${story.bg ?? 'violet'}`}>{story.caption}</div>
      )}
    </div>
  );
}
