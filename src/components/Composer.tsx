import { useRef, useState, type FormEvent, type RefObject } from 'react';
import type { PersonaDTO } from '../../shared/types';
import type { UiMessage } from '../lib/thread';
import { IconCamera, IconClose, IconImage } from './Icons';

interface Props {
  persona: PersonaDTO;
  aiConnected: boolean;
  replyingTo: UiMessage | null;
  onCancelReply: () => void;
  onSendText: (text: string) => void;
  onCamera: () => void;
  onPickFile: (file: File) => void;
  barRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The floating bar at the bottom: the message box, camera and photo buttons, and what's being
 * replied to. What's typed lives here, so typing doesn't re-render the whole chat.
 */
export function Composer({ persona, aiConnected, replyingTo, onCancelReply, onSendText, onCamera, onPickFile, barRef, inputRef }: Props) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    onSendText(value);
  };

  return (
    <div className="bottom-bar" ref={barRef}>
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
          <button type="button" className="icon-btn" onClick={onCancelReply} aria-label="Cancel reply">
            <IconClose size={20} />
          </button>
        </div>
      )}

      <form className="composer" onSubmit={submit}>
        <div className="composer-pill">
          <button type="button" className="camera-btn" onClick={onCamera} aria-label="Camera">
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
            onKeyDown={(e) => e.key === 'Escape' && onCancelReply()}
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
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) onPickFile(file);
            }}
          />
        </div>
      </form>
    </div>
  );
}
