import { eventChannel, type EventChannel } from 'redux-saga';

/** True in a browser; a test or the SSR pass has no document and is treated as visible. */
export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' ? true : document.visibilityState === 'visible';
}

/** `focus` plus `visibilitychange`, emitted only when the tab is actually visible. */
export function windowEventsChannel(): EventChannel<null> {
  return eventChannel<null>((emit) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
    const emitIfVisible = () => {
      if (isDocumentVisible()) emit(null);
    };
    document.addEventListener('visibilitychange', emitIfVisible);
    window.addEventListener('focus', emitIfVisible);
    return () => {
      document.removeEventListener('visibilitychange', emitIfVisible);
      window.removeEventListener('focus', emitIfVisible);
    };
  });
}

/** The extension's `Scraped` link lands on `/?card=<job_id>`. */
export function readCardQuery(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('card');
}