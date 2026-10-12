import { useRef, useState } from 'react';
import type { PersonaDTO } from '../../shared/types';
import { ApiError } from '../api';
import { useDialog } from '../lib/useDialog';
import { Avatar, type RingState } from './Avatar';

interface Props {
  persona: PersonaDTO;
  ring: RingState;
  onViewStory: () => void;
  onDeleteChat: () => Promise<void>;
  onClose: () => void;
}

/** Alisa's profile card, plus deleting the conversation. */
export function InfoSheet({ persona, ring, onViewStory, onDeleteChat, onClose }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDeleteChat();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t delete the chat. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={dialog} className="overlay sheet-wrap" role="dialog" aria-modal="true" aria-label={`About ${persona.name}`}>
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
          <p className="muted">{persona.handle}</p>
          <p>{persona.bio}</p>
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
              {error && (
                <p className="sheet-note form-error" role="alert">
                  {error}
                </p>
              )}
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
