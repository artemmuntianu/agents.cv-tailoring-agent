import { useEffect, useState } from 'react';

export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' ? true : document.visibilityState === 'visible';
}

export function readCardQuery(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('card');
}

/** Re-renders on visibility/focus so a query's polling interval can follow it. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isDocumentVisible());

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const update = () => setVisible(isDocumentVisible());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);

  return visible;
}