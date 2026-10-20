import { useEffect, useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { setupListeners } from '@reduxjs/toolkit/query/react';
import { makeStore, type AppStore } from './store';

interface IslandProviderProps {
  children: ReactNode;
  /** Tests inject a store; a page never does. */
  store?: AppStore;
}

/**
 * The store's lifetime is the island's: created on the first render, with RTK Query's
 * refetch-on-focus listeners installed in an effect and removed on unmount. Nothing is
 * fetched during the server pass.
 */
export default function IslandProvider({ children, store: injected }: IslandProviderProps) {
  const [store] = useState<AppStore>(() => injected ?? makeStore());

  useEffect(() => setupListeners(store.dispatch), [store]);

  return <Provider store={store}>{children}</Provider>;
}