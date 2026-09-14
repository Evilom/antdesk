import { useEffect, useRef } from 'react';

export function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const focusables = () => [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])].filter(el => el.getClientRects().length > 0);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeRef.current(); }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) { e.preventDefault(); return; }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && index <= 0) { e.preventDefault(); items.at(-1)?.focus(); }
      else if (!e.shiftKey && (index === -1 || index === items.length - 1)) {e.preventDefault(); items[0].focus();}
    };
    window.addEventListener('keydown', onKey, true);
    return () => {window.removeEventListener('keydown', onKey, true); previous?.focus();};
  }, [open]);
  return ref;
}
