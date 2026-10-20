# Proposal

## Why

The board's client state lives in one component. `apps/backoffice/src/components/App.tsx` declares twelve `useState` values (cards, loading, error, live, the three dialog cards, the open card, filters, the Action vocabulary and the note), reads `/api/board` and `/api/board/actions` in separate effects, runs the 5s live poll and the focus/visibility refetch itself, and performs every write through a local `mutate()` helper whose value is the write -> re-read -> report-failure order.

That behaviour is correct, but the contract is implicit: the order that keeps "the database is the display" true, the latest-wins rule between a poll and a confirmed move, and the 401 redirect are buried in component effects and can only be checked in a browser. Every other page repeats the same fetch/loading/error pattern, and the cover-letter page owns a polling timer of its own. The board is also the one screen where a state library pays for itself: one read feeds the columns, the counts, the filters and the modal, and one write must refresh all of them.

## What Changes

- Add `redux@5`, `react-redux@9`, `redux-saga@1.5` and `reselect@5` to `apps/backoffice`.
- Add a client state layer under `apps/backoffice/src/state/`:
  - `store.ts` (`makeStore`), `rootReducer.ts`, `rootSaga.ts`, `hooks.ts`, `IslandProvider.tsx`, `api/client.ts` (the one fetch wrapper: `content-type` on every non-GET, `{ ok, error }` parsing, 401 detection) and `events.ts` (an `eventChannel` for `focus`/`visibilitychange`).
  - `board`, `filters`, `dialogs` and `vocabulary` slices, their selectors and their sagas.
  - `cover` and `admin` slices, selectors and sagas.
- Move the board's effects into sagas: initial board + vocabulary read, the 5s live poll, the focus/visibility refetch, the `?card=` deep link, and every write (move, add action, archive, restore, remove, interview add/edit/remove, history edit/remove, details save, docx upload).
- Move the cover-letter page's read/ask/poll into `cover` sagas, keeping the 3s cadence and the 3-minute deadline.
- Move the admin vocabulary read and its add/rename/remove writes into `admin` sagas.
- Wrap each migrated island in `IslandProvider`; create the store per island instance, never at module scope.
- Keep `src/lib/*` pure, unchanged and the only place the filtering, sorting, analytics and wording rules live. The store is a client-side cache of `/api/board`, not a second source of truth.
- Add unit tests for reducers, selectors and sagas, and render checks for the migrated islands.
- Update `apps/backoffice/AGENTS.md` with the new layer and its conventions.

## Capabilities

### New Capabilities

_None._ This is a pure client-side refactor: the operator sees the same board, the same dialogs, the same polling cadence and the same error handling. No observable behaviour changes, so no spec delta is invented (`skip_specs: true` in `.openspec.yaml`).

### Modified Capabilities

_None._ The server routes, their responses and the database contract are untouched.

## Impact

- `apps/backoffice/package.json` and `package-lock.json` - four dependencies.
- `apps/backoffice/src/state/**` - new client state layer.
- `apps/backoffice/src/components/App.tsx` - the board root becomes a provider wrapper plus selectors and dispatches.
- `apps/backoffice/src/components/CoverLetterPage.tsx` and `AdminApp.tsx` - the same treatment.
- `apps/backoffice/src/components/{BoardToolbar,FilterDialog,KanbanBoard,VacancyModal,ActionVocabulary}.tsx` - only where a prop becomes a selector; their rendering rules do not change.
- `apps/backoffice/AGENTS.md` - the state layer, its conventions and its tests.
- **Not touched:** `src/pages/api/**`, `src/lib/db.ts`, `src/lib/queue.ts`, the worker, the extension, the charts, the database schema, the queue topology. `CONSTITUTION.md` invariants 19-29 are preserved by construction because no route changes.
- **Deliberately out of scope:** migrating the analytics, processes, sources, new-vacancy, vacancy-text and login islands (single `fetch` calls, no orchestration); Redux Toolkit; optimistic updates; persisting the store to `localStorage`.