import { type RefObject, useEffect, useRef } from 'react';

/** How far the chat slides left to show the times beside each message. */
const REVEAL_PX = 72;
/** How far a message has to be pulled right to start a reply. */
const REPLY_AT_PX = 56;
const SETTLE_MS = 220;
/** How far a drag goes before it counts as sideways (ours) or up-and-down (scrolling). */
const DECIDE_PX = 8;

/** Follows the finger up to `limit`, then gives a little rubber-band resistance. */
const rubber = (d: number, limit: number) => (d <= limit ? d : limit + (d - limit) * 0.15);

/**
 * Instagram's chat gestures, on touch screens:
 * - drag the chat left to slide every message over and show its time;
 * - drag one message right to reply to it.
 * On a laptop, a sideways two-finger trackpad swipe shows the times.
 *
 * Vertical scrolling stays with the browser (`touch-action: pan-y` on the
 * thread). The drag only updates CSS variables, so React doesn't re-render:
 * `--reveal` on the thread slides every row, `--swipe` on one row pulls it.
 *
 * Sideways drags are claimed through touch events too (preventDefault on touchmove): iPhone
 * Safari can otherwise take a sideways drag in a scrolling area, especially one that wobbles up
 * or down a little, as a scroll, and cancel it a few pixels in, snapping the times back.
 */
export function useThreadGestures(
  threadRef: RefObject<HTMLElement | null>,
  onReply: (messageId: number) => void,
  /** Re-attaches once the thread is on screen (it isn't while the chat loads). */
  ready: boolean,
) {
  const replyRef = useRef(onReply);
  replyRef.current = onReply;

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;

    type Drag = { id: number; x: number; y: number; row: HTMLElement | null; mode: 'pending' | 'times' | 'reply' | 'none' };
    let drag: Drag | null = null;
    let dx = 0;
    let frame = 0;

    const setReveal = (px: number) => {
      el.style.setProperty('--reveal', `${px}px`);
      el.style.setProperty('--reveal-o', String(Math.min(1, px / (REVEAL_PX * 0.8))));
    };
    const setSwipe = (row: HTMLElement, px: number) => {
      row.style.setProperty('--swipe', `${px}px`);
      row.style.setProperty('--swipe-o', String(Math.min(1, px / REPLY_AT_PX)));
      row.classList.toggle('swipe-armed', px >= REPLY_AT_PX);
    };
    const paint = () => {
      frame = 0;
      if (drag?.mode === 'times') setReveal(rubber(Math.max(0, -dx), REVEAL_PX));
      if (drag?.mode === 'reply' && drag.row) setSwipe(drag.row, rubber(Math.max(0, dx), REPLY_AT_PX + 8));
    };
    let settleTimer = 0;
    let settlingRow: HTMLElement | null = null;
    /** Stops the spring-back animation, so a new drag follows the finger straight away. */
    const stopSettling = () => {
      window.clearTimeout(settleTimer);
      el.classList.remove('settling');
      settlingRow?.classList.remove('settling');
      settlingRow = null;
    };
    const settle = (row: HTMLElement | null) => {
      stopSettling();
      el.classList.add('settling');
      row?.classList.add('settling');
      settlingRow = row;
      setReveal(0);
      if (row) setSwipe(row, 0);
      settleTimer = window.setTimeout(stopSettling, SETTLE_MS);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-msg-id]');
      stopSettling();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, row, mode: 'pending' };
      dx = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id || drag.mode === 'none') return;
      const mx = e.clientX - drag.x;
      const my = e.clientY - drag.y;
      if (drag.mode === 'pending') {
        if (Math.hypot(mx, my) < DECIDE_PX) return;
        // Mostly sideways: ours. Mostly up or down: the browser is scrolling.
        if (Math.abs(mx) < Math.abs(my) * 1.3) {
          drag.mode = 'none';
          return;
        }
        const replyable = !!drag.row && Number(drag.row.dataset.msgId) > 0;
        drag.mode = mx < 0 ? 'times' : replyable ? 'reply' : 'none';
        if (drag.mode === 'none') return;
      }
      dx = mx;
      frame ||= requestAnimationFrame(paint);
    };
    const onEnd = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const done = drag;
      drag = null;
      cancelAnimationFrame(frame);
      frame = 0;
      if (done.mode === 'reply' && done.row && dx >= REPLY_AT_PX) {
        navigator.vibrate?.(8);
        replyRef.current(Number(done.row.dataset.msgId));
      }
      if (done.mode === 'times' || done.mode === 'reply') settle(done.row);
    };

    // Keep the browser from scrolling (and cancelling the drag) once it's ours, or while it's
    // still undecided but heading sideways. Up-and-down drags are left alone, so they scroll.
    let touchStart: { x: number; y: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touchStart || e.touches.length !== 1 || !e.cancelable) return;
      const mode = drag?.mode;
      if (mode === 'times' || mode === 'reply') {
        e.preventDefault();
        return;
      }
      if (mode !== 'pending') return;
      const mx = Math.abs(e.touches[0].clientX - touchStart.x);
      const my = Math.abs(e.touches[0].clientY - touchStart.y);
      if (mx > 2 && mx > my) e.preventDefault();
    };

    // Trackpads: a sideways two-finger swipe shows the times, and they slide back once it stops.
    let wheelX = 0;
    let wheelTimer = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      wheelX = Math.max(0, wheelX + e.deltaX);
      setReveal(rubber(wheelX, REVEAL_PX));
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        wheelX = 0;
        settle(null);
      }, 160);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onEnd);
      el.removeEventListener('pointercancel', onEnd);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      cancelAnimationFrame(frame);
      window.clearTimeout(wheelTimer);
      stopSettling();
    };
  }, [threadRef, ready]);
}
