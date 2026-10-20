# Tasks

## 1. Dependencies and API

- [x] 1.1 Add `@reduxjs/toolkit@^2.13`, remove `redux-saga`, and verify `npm ls @reduxjs/toolkit redux react-redux` resolves cleanly.
- [x] 1.2 Create `src/state/api/baseQuery.ts` + `src/state/api/errors.ts` and one `src/state/{board,cover,admin}/api.ts` per slice with its queries and mutations; verify `npx tsc --noEmit`.

## 2. Store and provider

- [x] 2.1 Rewrite `src/state/store.ts` and `src/state/rootReducer.ts` around `configureStore` + the RTK Query reducer/middleware; keep the `filters` and `dialogs` slices; verify `npx tsc --noEmit`.
- [x] 2.2 Simplify `src/state/IslandProvider.tsx` to create the store and install `setupListeners`; delete `rootSaga.ts`, `request.ts`, `events.ts`; verify `npx tsc --noEmit`.

## 3. Board

- [x] 3.1 Rewire `src/components/App.tsx` to `useGetBoardQuery`/`useGetActionsQuery`, the mutations and explicit `refetch()`; restore the 5s visible-only poll, `?card=` and the write -> re-read -> report order; verify `npx tsc --noEmit`.
- [x] 3.2 Delete the board/vocabulary server-data slices, selectors and sagas; keep `filters`/`dialogs`; verify `npm test`, `npx tsc --noEmit`, `npm run build`.

## 4. Cover letter and admin

- [x] 4.1 Rewire `src/components/CoverLetterPage.tsx` to `useGetCoverQuery` (3s poll, 3-minute deadline) and `useAskCoverMutation`; delete `src/state/cover/**`; verify `npx tsc --noEmit`.
- [x] 4.2 Rewire `src/components/AdminApp.tsx` to `useGetAdminVocabularyQuery` and the three mutations with an awaited refetch; delete `src/state/admin/**`; verify `npx tsc --noEmit`.

## 5. Tests, docs and gates

- [x] 5.1 Replace the saga/API tests with one small `src/state/state.test.ts` for the filters/dialogs reducers and `errorMessage`; delete `sagas.test.ts`, `api/client.test.ts`, `IslandProvider.test.ts` and `board/fixtures.ts`; verify `npx vitest run src/state`.
- [x] 5.2 Update `apps/backoffice/AGENTS.md` (state-layer section, layout row, tests) to name RTK Query and the remaining slices; verify the diff is limited to `apps/backoffice` and the OpenSpec change.
- [x] 5.3 Run `npm test`, `npx tsc --noEmit`, `npm run build` and `openspec validate replace-redux-saga-with-rtk-query --strict`; verify all pass and `git status --short` lists only the paths this proposal names.

## Workflow follow-up

- Archive `replace-redux-saga-with-rtk-query` after review; the earlier `add-redux-saga-state` remains in the archive as the superseded design.