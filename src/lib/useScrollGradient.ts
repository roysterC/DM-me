import { type RefObject, useLayoutEffect } from 'react';

/**
 * Instagram's sent-bubble colour: one purple-to-blue gradient spans the visible
 * chat, and each bubble (class `sent-fill`) shows the slice behind where it sits
 * right now. Bubbles near the top are purple, near the bottom blue, and they
 * shift as you scroll. (`background-attachment: fixed` would do this, but
 * iPhone Safari ignores it.)
 *
 * Sets `--fill-h` on the thread and `--fill-y` on each on-screen bubble; the
 * CSS turns those into the background's size and offset.
 */
export function useScrollGradient(threadRef: RefObject<HTMLElement | null>, contentKey: unknown) {
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScreen = new Set<HTMLElement>();
    let frame = 0;

    const place = (nodes: Iterable<HTMLElement>) => {
      const top = el.getBoundingClientRect().top;
      const list = [...nodes];
      // Read every position first, then write, so the browser lays out once.
      const offsets = list.map((n) => n.getBoundingClientRect().top - top);
      el.style.setProperty('--fill-h', `${el.clientHeight}px`);
      list.forEach((n, i) => n.style.setProperty('--fill-y', `${-offsets[i]}px`));
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        place(onScreen);
      });
    };

    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = e.target as HTMLElement;
          if (e.isIntersecting) onScreen.add(n);
          else onScreen.delete(n);
        }
      },
      { root: el, rootMargin: '200px 0px' },
    );
    const all = el.querySelectorAll<HTMLElement>('.sent-fill');
    all.forEach((n) => seen.observe(n));
    place(all);

    const resized = new ResizeObserver(() => place(el.querySelectorAll<HTMLElement>('.sent-fill')));
    resized.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      seen.disconnect();
      resized.disconnect();
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [threadRef, contentKey]);
}
