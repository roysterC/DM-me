import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { PersonaDTO, UserDTO } from '../../shared/types';
import { Avatar, type RingState } from './Avatar';

interface Props {
  persona: PersonaDTO;
  user: UserDTO;
  ring: RingState;
  onViewStory: () => void;
  onLogout: () => void;
  onClose: () => void;
}

/** Nova's profile card, plus account actions. */
export function InfoSheet({ persona, user, ring, onViewStory, onLogout, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
          <p className="muted">
            {persona.handle} · AI on DM-me
          </p>
          <p>{persona.bio}</p>
          <p className="muted small">{persona.name} is an AI. Replies are generated and can be wrong.</p>
        </div>
        <div className="sheet-actions">
          {ring !== 'none' && (
            <button type="button" className="sheet-btn" onClick={onViewStory}>
              View story
            </button>
          )}
          {user.isAdmin && (
            <Link className="sheet-btn" to="/admin">
              Manage stories
            </Link>
          )}
          <button type="button" className="sheet-btn danger" onClick={onLogout}>
            Log out @{user.username}
          </button>
        </div>
      </div>
    </div>
  );
}
