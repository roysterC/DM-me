import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

/** Within this many pixels of the bottom counts as reading the latest messages. */
const NEAR_BOTTOM_PX = 80;

export const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

interface Parts {
  phone: RefObject<HTMLElement | null>;
  thread: RefObject<HTMLElement | null>;
  header: RefObject<HTMLElement | null>;
  bottom: RefObject<HTMLElement | null>;
}

/**
 * Keeps the chat at its newest message the way a messenger does: new messages scroll into view
 * while the visitor is at the bottom (or has just sent something), never while they're reading
 * further up. Also leaves room for the floating top and bottom bars. Scrolls whenever
 * `changes` changes; call `pin()` when the visitor sends something.
 */
export function useChatScroll({ phone, thread, header, bottom }: Parts, ready: boolean, empty: boolean, changes: unknown[]) {
  const pinned = useRef(true);
  // Set during our own smooth scroll down, whose in-between positions aren't the visitor's doing.
  const autoScrolling = useRef(false);
  const firstScroll = useRef(true);

  useLayoutEffect(() => {
    const el = thread.current;
    if (!el || !ready || empty) return;
    if (!firstScroll.current && !pinned.current) return;
    const behavior = firstScroll.current ? 'auto' : scrollBehavior();
    autoScrolling.current = behavior === 'smooth' && el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    el.scrollTo({ top: el.scrollHeight, behavior });
    firstScroll.current = false;
  }, changes);

  // The top and bottom bars float over the chat; leave room for them, and stay at the
  // bottom when the bottom bar grows (a reply preview opening, say).
  useLayoutEffect(() => {
    const ph = phone.current;
    const th = thread.current;
    const top = header.current;
    const bar = bottom.current;
    if (!ph || !th || !top || !bar) return;
    const distance = () => th.scrollHeight - th.scrollTop - th.clientHeight;
    const measure = () => {
      const atBottom = distance() < NEAR_BOTTOM_PX;
      ph.style.setProperty('--top-h', `${top.offsetHeight}px`);
      ph.style.setProperty('--bottom-h', `${bar.offsetHeight}px`);
      if (atBottom) th.scrollTop = th.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(top);
    observer.observe(bar);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (autoScrolling.current) {
        // Done once it reaches the bottom, or shortly after it stops moving (the visitor may
        // have scrolled away mid-way, so look again then).
        clearTimeout(settle);
        if (distance() < 2) autoScrolling.current = false;
        else
          settle = setTimeout(() => {
            autoScrolling.current = false;
            pinned.current = distance() < NEAR_BOTTOM_PX;
          }, 200);
        return;
      }
      pinned.current = distance() < NEAR_BOTTOM_PX;
    };
    th.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      th.removeEventListener('scroll', onScroll);
      clearTimeout(settle);
    };
  }, [ready]);

  // Sending something always shows it, even from further up the chat.
  const pin = useCallback(() => {
    pinned.current = true;
  }, []);
  return { pin };
}
