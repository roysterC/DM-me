import { useEffect, useState } from 'react';
import type { PersonaDTO } from '../../shared/types';
import { Avatar, type RingState } from './Avatar';

interface Props {
  persona: PersonaDTO;
  ring: RingState;
  onViewStory: () => void;
  onDeleteChat: () => Promise<void>;
  onClose: () => void;
}

/** Nova's profile card, plus deleting the conversation. */
export function InfoSheet({ persona, ring, onViewStory, onDeleteChat, onClose }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const remove = async () => {
    setBusy(true);
    try {
      await onDeleteChat();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay sheet-wrap" role="dialog" aria-modal="true" aria-label={`About ${persona.name}`}>
      <button type="button" className="sheet-backdrop" onClick={onClose} aria-label="Close" />
      <div className="sheet">
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-profile">
          <Avatar
            persona={persona}
            size={88}
            ring={ring}
            onClick={ring === 'none' ? undefined : onViewStory}
            label={`View ${persona.name}’s story`}
          />
          <h2>{persona.name}</h2>
          <p className="muted">{persona.handle} · AI on DM-me</p>
          <p>{persona.bio}</p>
          <p className="muted small">{persona.name} is an AI. Replies are generated and can be wrong.</p>
        </div>
        <div className="sheet-actions">
          {ring !== 'none' && (
            <button type="button" className="sheet-btn" onClick={onViewStory}>
              View story
            </button>
          )}
          {confirming ? (
            <>
              <p className="sheet-note">This deletes every message and photo in this chat. It can’t be undone.</p>
              <button type="button" className="sheet-btn danger" onClick={remove} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete chat'}
              </button>
              <button type="button" className="sheet-btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="sheet-btn danger" onClick={() => setConfirming(true)}>
              Delete chat
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
