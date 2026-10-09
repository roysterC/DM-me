import { useRef } from 'react';

/** One Instagram-style progress segment. `state` "active" animates over `seconds` and calls onDone at the end. */
export function TimerBar({
  state,
  seconds,
  paused,
  onDone,
}: {
  state: 'done' | 'active' | 'todo';
  seconds: number;
  paused: boolean;
  onDone?: () => void;
}) {
  return (
    <div className="timer-track">
      {state === 'done' && <div className="timer-fill" style={{ width: '100%' }} />}
      {state === 'active' && (
        <div
          className="timer-fill timer-run"
          style={{ animationDuration: `${seconds}s`, animationPlayState: paused ? 'paused' : 'running' }}
          onAnimationEnd={onDone}
        />
      )}
    </div>
  );
}

/**
 * Press-and-hold pauses; a quick press counts as a tap. Returns handlers for a
 * tap zone plus whether it is currently held.
 */
export function useHoldToPause(setHeld: (held: boolean) => void) {
  const downAt = useRef(0);
  const wasHold = useRef(false);
  return {
    onPointerDown: () => {
      downAt.current = Date.now();
      setHeld(true);
    },
    onPointerUp: () => {
      wasHold.current = Date.now() - downAt.current > 250;
      setHeld(false);
    },
    onPointerLeave: () => setHeld(false),
    onPointerCancel: () => setHeld(false),
    /** Call at the top of onClick: true when the click ended a hold and should be ignored. */
    consumeHold: () => {
      const v = wasHold.current;
      wasHold.current = false;
      return v;
    },
  };
}
