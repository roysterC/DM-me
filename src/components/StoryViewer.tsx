import { useEffect, useState, type FormEvent } from 'react';
import type { PersonaDTO, StoryDTO } from '../../shared/types';
import { shortAge } from '../lib/time';
import { Avatar } from './Avatar';
import { IconClose, IconHeart, IconSend } from './Icons';
import { TimerBar, useHoldToPause } from './TimerBar';

interface Props {
  stories: StoryDTO[];
  startIndex: number;
  persona: PersonaDTO;
  seconds?: number;
  onClose: () => void;
  onSeen: (story: StoryDTO) => void;
  onLike: (story: StoryDTO, on: boolean) => void;
  onReply: (story: StoryDTO, text: string) => Promise<void>;
}

export function StoryViewer({ stories, startIndex, persona, seconds = 5, onClose, onSeen, onLike, onReply }: Props) {
  const [index, setIndex] = useState(startIndex);
  const [restart, setRestart] = useState(0);
  const [held, setHeld] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const story = stories[index];
  const paused = held || typing || !!toast;

  useEffect(() => {
    if (story) onSeen(story);
  }, [story?.id]);

  const next = () => (index < stories.length - 1 ? setIndex(index + 1) : onClose());
  const prev = () => (index > 0 ? setIndex(index - 1) : setRestart((r) => r + 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const { consumeHold, ...holdHandlers } = useHoldToPause(setHeld);
  if (!story) return null;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    (document.activeElement as HTMLElement | null)?.blur();
    try {
      await onReply(story, value);
      setToast('Sent');
    } catch {
      setToast('Couldn’t send');
    }
    setTimeout(() => setToast(null), 1200);
  };

  return (
    <div className="overlay story-viewer" role="dialog" aria-modal="true" aria-label={`${persona.name}’s story`}>
      <div className="story-stage">
        {story.kind === 'photo' && story.mediaUrl ? (
          <img className="story-media" src={story.mediaUrl} alt={story.caption ?? `${persona.name}’s story`} />
        ) : (
          <div className={`story-text bg-${story.bg ?? 'violet'}`}>
            <p>{story.caption}</p>
          </div>
        )}
        {story.kind === 'photo' && story.caption && (
          <div className="story-caption">
            <span>{story.caption}</span>
          </div>
        )}
        <div className="story-scrim" />

        <button
          type="button"
          className="tap-zone tap-prev"
          aria-label="Previous story"
          {...holdHandlers}
          onClick={() => !consumeHold() && prev()}
        />
        <button
          type="button"
          className="tap-zone tap-next"
          aria-label="Next story"
          {...holdHandlers}
          onClick={() => !consumeHold() && next()}
        />

        <div className="story-top">
          <div className="timer-row">
            {stories.map((s, i) => (
              <TimerBar
                key={i === index ? `${s.id}-${restart}` : s.id}
                state={i < index ? 'done' : i === index ? 'active' : 'todo'}
                seconds={seconds}
                paused={paused}
                onDone={next}
              />
            ))}
          </div>
          <div className="viewer-head">
            <Avatar persona={persona} size={32} />
            <span className="viewer-name">{persona.name}</span>
            <span className="viewer-age">{shortAge(story.createdAt)}</span>
            <span className="spacer" />
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close story">
              <IconClose size={24} />
            </button>
          </div>
        </div>
        {toast && <div className="viewer-toast">{toast}</div>}
      </div>

      <form className="viewer-reply" onSubmit={send}>
        <label className="sr-only" htmlFor="story-reply">
          Reply to {persona.name}’s story
        </label>
        <input
          id="story-reply"
          placeholder={`Reply to ${persona.name.toLowerCase()}…`}
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
            aria-label={story.liked ? 'Unlike story' : 'Like story'}
            aria-pressed={story.liked}
            onClick={() => onLike(story, !story.liked)}
          >
            <IconHeart size={26} filled={story.liked} />
          </button>
        )}
      </form>
    </div>
  );
}
