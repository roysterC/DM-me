import { useEffect, useRef, useState } from 'react';
import type { PersonaDTO } from '../../shared/types';
import { ApiError } from '../api';
import { disablePush, enablePush, pushEnabled, pushSupport } from '../lib/push';
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
          <Notifications name={persona.name} />
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

/** "Notify me when Alisa replies", or why this device can't. */
function Notifications({ name }: { name: string }) {
  const support = pushSupport();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    pushEnabled()
      .then(setOn)
      .catch(() => setOn(false));
  }, []);

  if (support === 'unsupported') return null;
  if (support === 'install') {
    return <p className="sheet-note">To get a notification when {name} replies, add this page to your Home Screen (Share, then Add to Home Screen) and open it from there.</p>;
  }
  if (support === 'blocked') {
    return <p className="sheet-note">Notifications are turned off for this site in your browser settings.</p>;
  }
  if (on === null) return null;

  const toggle = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (on) {
        await disablePush();
        setOn(false);
      } else if (await enablePush()) {
        setOn(true);
        setNote(`You’ll get a notification when ${name} replies while the chat is closed.`);
      } else {
        setNote('Notifications weren’t allowed.');
      }
    } catch {
      setNote('Couldn’t change notifications. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="sheet-btn" onClick={toggle} disabled={busy} aria-pressed={on}>
        {on ? 'Notifications on · Turn off' : `Notify me when ${name} replies`}
      </button>
      {note && (
        <p className="sheet-note" role="status">
          {note}
        </p>
      )}
    </>
  );
}
