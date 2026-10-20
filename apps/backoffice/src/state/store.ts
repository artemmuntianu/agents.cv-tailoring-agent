import {
  applyMiddleware,
  createStore,
  type Dispatch,
  type Reducer,
  type Store,
  type UnknownAction,
} from 'redux';
import createSagaMiddleware, { type SagaMiddleware } from 'redux-saga';
import rootReducer, { type RootState } from './rootReducer';
export type { RootState } from './rootReducer';
import rootSaga from './rootSaga';

export type AppDispatch = Dispatch<any>;
export type AppStore = Store<RootState, any> & { runSaga: SagaMiddleware['run'] };

/** `combineReducers` narrows the action type per slice; the store is the union of them. */
export type PreloadedState = Partial<RootState>;

/**
 * One store per island instance. Never a module singleton: `client:load` islands are also
 * server-rendered, so a shared store would leak one operator's board into another request.
 */
export function makeStore(preloadedState?: PreloadedState): AppStore {
  const sagaMiddleware = createSagaMiddleware();
  const store = createStore(
    rootReducer as unknown as Reducer<RootState, UnknownAction, PreloadedState>,
    preloadedState,
    applyMiddleware(sagaMiddleware),
  );
  return Object.assign(store, { runSaga: sagaMiddleware.run });
}

export { rootSaga };