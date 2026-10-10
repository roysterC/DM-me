import type { PersonaDTO } from '../../shared/types';

export type RingState = 'none' | 'unseen' | 'seen';

interface Props {
  persona: Pick<PersonaDTO, 'initial' | 'name'>;
  size: number;
  ring?: RingState;
  active?: boolean;
  onClick?: () => void;
  label?: string;
}

/** Alisa's round avatar, optionally inside Instagram's story ring. */
export function Avatar({ persona, size, ring = 'none', active, onClick, label }: Props) {
  const pad = ring === 'none' ? 0 : size >= 80 ? 3 : 2;
  const inner = size - pad * 2;
  const face = (
    <span
      className="avatar-face"
      style={{
        width: inner,
        height: inner,
        fontSize: Math.round(inner * 0.4),
        borderWidth: ring === 'none' ? 0 : pad,
      }}
    >
      {persona.initial}
    </span>
  );
  const body = (
    <>
      <span className={`avatar-ring ring-${ring}`} style={{ width: size, height: size, padding: pad }}>
        {face}
      </span>
      {active && <span className="avatar-active" />}
    </>
  );
  if (!onClick) {
    return (
      <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
        {body}
      </span>
    );
  }
  return (
    <button type="button" className="avatar avatar-button" style={{ width: size, height: size }} onClick={onClick} aria-label={label}>
      {body}
    </button>
  );
}
