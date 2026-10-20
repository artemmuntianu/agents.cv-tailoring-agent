# Proposal

## Why

The previous change put the board's server state behind Redux + Redux Saga. The sagas carry the poll, the write -> re-read order, the cover-letter deadline and the admin re-read by hand. RTK Query already owns exactly that half - a request cache, polling, mutation state and refetching - so keeping the saga layer duplicates it: a root saga, a start action, request callbacks in action metadata, an event channel and saga-specific tests all exist only to re-implement what the query cache does.

Replacing the sagas with RTK Query keeps the same observable behaviour while deleting a whole layer of orchestration.

## What Changes

- Add `@reduxjs/toolkit@^2.13` and remove `redux-saga@^1.5`.
- Add `src/state/api.ts`: one `createApi` with `fetchBaseQuery` for the board, the Action vocabulary, the cover letter and the admin vocabulary, plus their mutations. A small wrapper sends a 401 to `/login?next=...`.
- Rewrite the store with `configureStore` (RTK Query reducer + middleware) and enable `refetchOnFocus`/`refetchOnReconnect` through `setupListeners`.
- `IslandProvider` no longer starts a root saga or dispatches a start action: queries start when a component mounts, and the provider only creates the store and installs the listeners.
- The board uses `useGetBoardQuery` + `useGetActionsQuery`; live mode is the query's `pollingInterval` (paused while the tab is hidden), and every write is a mutation followed by an explicit `refetch()` so the re-read still finishes before a failure is shown.
- The cover-letter page uses `useGetCoverQuery` with a 3s poll and the 3-minute deadline, and `useAskCoverMutation` for the ask.
- The admin page uses `useGetAdminVocabularyQuery` and the three vocabulary mutations, refetching after each write.
- Keep the small UI slices (`filters`, `dialogs`) and local UI state (`live`, note, write error); delete the saga-aware slices, selectors, `rootSaga`, `request.ts`, `events.ts` and the saga tests.
- Update `apps/backoffice/AGENTS.md` and trim the tests to the pure state that remains.

**No Immutable.js, and no behaviour change:** the board still re-reads after every write, live mode still polls every 5s while visible, the cover letter still polls until it lands or 3 minutes pass, and a refused write still leaves the previous board on screen. `skip_specs: true` because this is a pure implementation swap.

## Capabilities

### New Capabilities

_None._ Pure refactor; no observable behaviour changes, so no spec delta is invented.

### Modified Capabilities

_None._ The server routes, responses and database contract are untouched.

## Impact

- `apps/backoffice/package.json` and `package-lock.json` - `@reduxjs/toolkit` added, `redux-saga` removed.
- `apps/backoffice/src/state/**` - `api.ts` and a smaller store; saga files, server-data slices/selectors, `request.ts` and `events.ts` removed.
- `App.tsx`, `CoverLetterPage.tsx`, `AdminApp.tsx` - query/mutation hooks replace the store-backed effects.
- `apps/backoffice/AGENTS.md` - the state-layer section and the tests it names.
- **Not touched:** API routes, `lib/db.ts`, the queue, the worker, the extension, the charts, the schema.
- **Out of scope:** migrating `/analytics`, `/processes`, `/sources`, `/new-vacancy`, `/vacancy/<id>` or `/login`; they keep their plain `fetch`/form shape.