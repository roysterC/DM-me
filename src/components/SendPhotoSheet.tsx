import { useEffect, useState } from 'react';
import type { PersonaDTO, PhotoMode } from '../../shared/types';
import type { PreparedImage } from '../lib/image';
import { Avatar } from './Avatar';
import { IconArrow, IconClose, IconDownload, IconKeep, IconOnce, IconReplay } from './Icons';

const MODES: { id: PhotoMode; label: string; Icon: typeof IconOnce }[] = [
  { id: 'once', label: 'View once', Icon: IconOnce },
  { id: 'replay', label: 'Allow replay', Icon: IconReplay },
  { id: 'keep', label: 'Keep in chat', Icon: IconKeep },
];

interface Props {
  image: PreparedImage;
  persona: PersonaDTO;
  defaultMode: PhotoMode;
  onCancel: () => void;
  onSend: (mode: PhotoMode) => void;
}

/** Preview after taking or choosing a photo: pick how Alisa can see it, then send. */
export function SendPhotoSheet({ image, persona, defaultMode, onCancel, onSend }: Props) {
  const [mode, setMode] = useState<PhotoMode>(defaultMode);
  const name = persona.name;
  const hint =
    mode === 'once'
      ? `${name} can open it once, then it’s gone.`
      : mode === 'replay'
        ? `${name} can open it, then replay it one more time.`
        : 'Stays in the chat like a normal photo.';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="overlay send-photo" role="dialog" aria-modal="true" aria-label="Send photo">
      <div className="send-photo-stage">
        <img src={image.url} alt="The photo you’re about to send" />
        <div className="send-photo-top">
          <button type="button" className="round-btn" onClick={onCancel} aria-label="Discard photo">
            <IconClose size={22} />
          </button>
          <a className="round-btn" href={image.url} download="dm-me-photo.jpg" aria-label="Save photo">
            <IconDownload size={22} />
          </a>
        </div>
      </div>
      <div className="send-photo-controls">
        <div className="mode-switch" role="radiogroup" aria-label={`How ${name} can see this photo`}>
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={mode === id ? 'selected' : undefined}
              onClick={() => setMode(id)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        <p className="mode-hint">{hint}</p>
        <div className="send-row">
          <span className="to-chip">
            <Avatar persona={persona} size={30} />
            {name}
          </span>
          <button type="button" className="send-pill" onClick={() => onSend(mode)}>
            Send
            <IconArrow size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
