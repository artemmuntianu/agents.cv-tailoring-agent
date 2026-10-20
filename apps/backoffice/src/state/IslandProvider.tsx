import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import rootSaga from './rootSaga';
import { makeStore, type AppStore } from './store';

export type IslandStart = () => { type: string };

/**
 * Start the island's saga and immediately dispatch its first action.
 *
 * Order matters: a child effect runs before the provider's effect, so a page that dispatched
 * its own start action would do it before the saga existed and the action would be lost.
 */
export function startIsland(store: AppStore, start?: IslandStart) {
  const task = store.runSaga(rootSaga);
  const action = start?.();
  if (action) store.dispatch(action);
  return task;
}

interface IslandProviderProps {
  children: ReactNode;
  /** Tests inject a store; a page never does. */
  store?: AppStore;
  /** The island's first action, dispatched after the root saga is listening. */
  start?: IslandStart;
}

/**
 * The store's lifetime is the island's: created on the first render, saga started in an effect
 * (so the server pass dispatches nothing) and cancelled when the island unmounts.
 */
export default function IslandProvider({ children, store: injected, start }: IslandProviderProps) {
  const [store] = useState<AppStore>(() => injected ?? makeStore());
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    const task = startIsland(store, startRef.current);
    return () => {
      task.cancel();
    };
  }, [store]);

  return <Provider store={store}>{children}</Provider>;
}