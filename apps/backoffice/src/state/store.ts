import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { adminApi } from './admin/api';
import { boardApi } from './board/api';
import { coverApi } from './cover/api';
import dialogs from './dialogs/slice';
import filters from './filters/slice';

const rootReducer = combineReducers({
  [boardApi.reducerPath]: boardApi.reducer,
  [coverApi.reducerPath]: coverApi.reducer,
  [adminApi.reducerPath]: adminApi.reducer,
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
    middleware: (getDefault) =>
      getDefault().concat(boardApi.middleware, coverApi.middleware, adminApi.middleware),
  });
}

export type AppStore = ReturnType<typeof makeStore>;
export type AppDispatch = AppStore['dispatch'];