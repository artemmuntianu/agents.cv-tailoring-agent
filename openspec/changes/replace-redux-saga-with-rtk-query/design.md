# Design

## Context

The current layer is plain Redux 5 + Redux Saga 1.5. `rootSaga` forks board/cover/admin watchers, `IslandProvider` starts it in an effect and dispatches the island's first action, `request.ts` resolves card-dialog promises through action metadata, and `events.ts` turns `focus`/`visibilitychange` into an event channel. The board's contract is still "POST, re-read `/api/board`, and only then report the failure".

RTK Query is a cache with request deduplication, polling, mutation state and refetch-on-focus. That is the same half the sagas implement by hand.

## Goals / Non-Goals

**Goals:**

- One owner for server state (RTK Query) and one for UI state (the `filters`/`dialogs` slices).
- Preserve every observable contract: 5s visible-only board poll, 3s cover poll with a 3-minute deadline, write -> re-read -> report, 401 redirect, no optimistic update.
- Delete the saga lifecycle, request metadata and the event channel.

**Non-Goals:**

- No route, database, queue or worker change.
- No Immutable.js, no persisted cache, no optimistic updates.
- No migration of the single-fetch pages.

## Decisions

### Decision: RTK Query owns server data; Redux keeps only UI state

`src/state/{board,cover,admin}/api.ts` hold every request, one `createApi` per slice, sharing the base query and the error helper. The Redux store keeps `filters` and `dialogs` (multiple components read them) and RTK Query's cache; the board's `note`, `live` and write error are component state because only the board reads them.

*Alternative rejected: keep the sagas alongside RTK Query.* Two caches and two effect systems would have to agree about the same rows, which is exactly the duplication this change removes.

### Decision: explicit `refetch()` after a write, not `invalidatesTags` alone

The board contract is that the re-read completes before the failure is reported, and a failed write still re-reads. Tag invalidation is fire-and-forget, so each page awaits `refetch()` in the handler (success and, for board-level writes, failure). That also avoids a second automatic fetch after the explicit one.

*Alternative rejected: optimistic updates.* The screen must never disagree with Postgres, and a refusal or restore is an explicit operator act.

### Decision: polling is a hook option

`useGetBoardQuery(undefined, { pollingInterval: live && visible ? 5000 : 0 })`; `refetchOnFocus`/`refetchOnReconnect` come from `setupListeners`. The cover page uses `pollingInterval: pending && !expired ? 3000 : 0` with a local 3-minute timer. `refetchOnFocus` is installed once per store in `IslandProvider`.

*Alternative rejected: the saga's `delay`/`race` loops and the `eventChannel`.* They re-implement the query cache's own scheduling.

### Decision: `fetchBaseQuery` wrapper for 401 and JSON

`fetchBaseQuery` sets `content-type: application/json` for an object body and leaves `FormData` alone, so the DOCX upload keeps working. A thin wrapper checks a 401 and redirects to `/login?next=<current path>`; every other error is mapped by `errorMessage` (`data.error` or the HTTP status).

### Decision: the provider no longer starts anything

Queries start on mount. `IslandProvider` creates the store in `useState`, calls `setupListeners(store.dispatch)` in an effect and cancels the listeners on unmount. `startIsland` and the start action disappear, which also removes the child-effect ordering trap.

### Decision: keep the test surface small

The pure `lib/*` suite is untouched. The state tests shrink to the filters/dialogs reducers and `errorMessage`; the request layer is covered by `tsc`, `npm run build` and the operator's browser checks rather than a new mocking framework.

*Alternative rejected: adding MSW/`msw` for endpoint tests.* It buys coverage of code whose contract is already the server's, and the user asked for a minimal test surface.

## Risks / Trade-offs

- **Hooks replace selectors in the three islands.** The board's handlers are now `async` and await `refetch()`; a component that forgets the await would show the note before the new board arrives. The handlers keep that order in one place per island.
- **The cache is per island.** A page navigation still starts from the server, as before; nothing is persisted.
- **Polling while hidden** is prevented by `pollingInterval: 0` when `document.visibilityState !== 'visible'`; the hook re-renders on `visibilitychange`.
- **Bundle:** `@reduxjs/toolkit` replaces `redux` + `reselect` as the store core (RTK re-exports both) and removes `redux-saga`; the app-level bundle stays comparable.
