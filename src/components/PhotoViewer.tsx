import { useEffect, useState, type FormEvent } from 'react';
import type { OpenPhotoDTO, PersonaDTO } from '../../shared/types';
import type { UiMessage } from '../lib/thread';
import { shortAge } from '../lib/time';
import { Avatar } from './Avatar';
import { IconClose, IconHeart, IconOnce, IconReplay, IconSend } from './Icons';
import { TimerBar, useHoldToPause } from './TimerBar';

interface Props {
  message: UiMessage;
  opened: OpenPhotoDTO;
  persona: PersonaDTO;
  onClose: () => void;
  onReply: (text: string) => void;
  onToggleHeart: () => void;
}

/** Full-screen view of a view-once or replay photo Alisa sent, with its countdown. */
export function PhotoViewer({ message, opened, persona, onClose, onReply, onToggleHeart }: Props) {
  const [held, setHeld] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const { consumeHold, ...holdHandlers } = useHoldToPause(setHeld);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const replay = opened.maxViews > 1;
  const note = !replay
    ? `View once · closes in ${opened.seconds}s`
    : opened.viewCount < opened.maxViews
      ? 'You can replay this once'
      : 'Replaying · won’t open again';

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onReply(text.trim());
    onClose();
  };

  return (
    <div className="overlay photo-viewer" role="dialog" aria-modal="true" aria-label={`Photo from ${persona.name}`}>
      <div className="story-stage">
        <img className="story-media" src={opened.url} alt={`Photo from ${persona.name}`} />
        <div className="story-scrim" />
        <button type="button" className="tap-zone tap-all" aria-label="Hold to pause" {...holdHandlers} onClick={() => consumeHold()} />
        <div className="story-top">
          <div className="timer-row">
            <TimerBar state="active" seconds={opened.seconds} paused={held || typing} onDone={onClose} />
          </div>
          <div className="viewer-head">
            <Avatar persona={persona} size={32} />
            <span className="viewer-name">{persona.name}</span>
            <span className="viewer-age">{shortAge(message.createdAt)}</span>
            <span className="spacer" />
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close photo">
              <IconClose size={24} />
            </button>
          </div>
        </div>
        <div className="viewer-note">
          {replay ? <IconReplay size={15} /> : <IconOnce size={15} />}
          {note}
        </div>
      </div>
      <form className="viewer-reply" onSubmit={send}>
        <label className="sr-only" htmlFor="photo-reply">
          Reply to {persona.name}
        </label>
        <input
          id="photo-reply"
          placeholder="Send message"
          autoComplete="off"
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
        />
        {text.trim() ? (
          <button type="submit" className="icon-btn" aria-label="Send reply">
            <IconSend size={24} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label={message.heartByUser ? 'Remove heart' : 'Heart this photo'}
            aria-pressed={message.heartByUser}
            onClick={onToggleHeart}
          >
            <IconHeart size={26} filled={message.heartByUser} />
          </button>
        )}
      </form>
    </div>
  );
}

/** Plain full-screen view for photos kept in the chat. */
export function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay lightbox" role="dialog" aria-modal="true" aria-label={alt}>
      <button type="button" className="lightbox-backdrop" onClick={onClose} aria-label="Close photo" />
      <img src={url} alt={alt} />
      <button type="button" className="icon-btn lightbox-close" onClick={onClose} aria-label="Close photo">
        <IconClose size={24} />
      </button>
    </div>
  );
}
