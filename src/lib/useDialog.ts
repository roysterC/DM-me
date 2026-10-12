import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes an overlay behave as a dialog for keyboard and screen-reader users: focus moves into it
 * when it opens, Tab stays inside it, Escape closes it (unless `escape` is false, for overlays
 * that handle keys themselves), and focus goes back to where it was when it closes.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, { escape = true } = {}) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dialog itself takes focus first, so screen readers announce it; Tab then moves in.
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });

    const focusables = () =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escape) {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus can't leave by clicking or by script either.
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !dialog.contains(e.target)) (focusables()[0] ?? dialog).focus({ preventScroll: true });
    };
    dialog.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      dialog.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [ref, escape]);
}
