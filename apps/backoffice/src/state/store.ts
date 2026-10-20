import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { api } from './api';
import dialogs from './dialogs/slice';
import filters from './filters/slice';

const rootReducer = combineReducers({
  [api.reducerPath]: api.reducer,
  dialogs,
  filters,
});

export type RootState = ReturnType<typeof rootReducer>;

/**
 * One store per island instance. Never a module singleton: `client:load` islands are also
 * server-rendered, so a shared store would leak one operator's board into another request.
 */
export function makeStore() {
  return configureStore({
    reducer: rootReducer,
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });
}

export type AppStore = ReturnType<typeof makeStore>;
export type AppDispatch = AppStore['dispatch'];