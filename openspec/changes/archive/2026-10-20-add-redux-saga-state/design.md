# Design

## Context

The board is an Astro island (`client:load`) hydrated on the server's HTML. `App.tsx` owns twelve `useState` values, three effects, a `mutate()` helper and about a dozen handlers. The same shape repeats on `/cover/<job_id>` (a read, an ask and a self-poll) and `/admin` (a read, three writes and a re-read). Every write follows the same contract: POST, re-read `/api/board` and `/api/board/actions`, and only then report the failure, so the database remains the display (`apps/backoffice/AGENTS.md`, "Board contract").

Constraints that shape the approach:

- `client:load` islands are SSR-rendered; a module-level store would leak state across requests on the standalone Node adapter.
- The server-rendered HTML and the first client render must agree, so no state may be read from `localStorage` or the URL during render (the `NavBar` comment states the same rule).
- Every non-GET needs a `content-type`, including body-less calls, or Astro's `checkOrigin` refuses it (measured 2026-09-27).
- The tests run in vitest's node environment, with `renderToString` for components and hand-built jsdom for the browser-only libraries.
- `src/lib/*` owns the rules (filtering, sorting, analytics, wording) and is unit tested. The refactor must not move a rule into a component or a saga.

## Goals / Non-Goals

**Goals:**

- One inspectable owner for the board's client state, with reads, writes and timers expressed as effects that can be tested without a browser.
- Preserve every observable contract: poll cadence, visibility guard, 401 redirect, write -> re-read -> report, draft safety, no silent change.
- Keep `src/lib/*` pure and unchanged.

**Non-Goals:**

- No server change: no route, table, queue message, worker or chart value.
- No migration of the single-fetch islands in this change.

## Decisions

### Decision: plain Redux 5 + redux-saga + reselect, not Redux Toolkit

The requested stack is explicit, and plain Redux keeps the refactor's point visible: reducers are pure functions, effects are sagas, and selectors are memoized on purpose. `reselect` is included because the board's derived lists are read by several components (the columns, the nav counts, the modal), and `useSelector` must not build a new array on every store change.

*Alternative rejected: Redux Toolkit.* It would shorten the reducers, but it brings Immer and a second set of conventions into a change whose point is to make an existing contract explicit, and it adds a dependency the change does not need. A future change can adopt it without touching the saga layer.

### Decision: one store per island instance, created in the provider

`IslandProvider` creates the store with `useState(() => makeStore())`, starts the root saga in an effect and cancels it on unmount. A module singleton is rejected because `client:load` islands are server-rendered: one process would serve every request from the same store, leaking one operator's board into another request.

The island's first action goes through `startIsland`, which dispatches it immediately after `runSaga`. It must not come from a child effect: child effects run before the provider's, so the action would be dispatched before the saga existed and be lost - the bug that left `/admin` on `Loading…` forever (2026-10-20).

### Decision: `mutateSaga` is the only implementation of the write contract

Every confirmed change calls one helper: `POST` -> `put(noteCleared)` -> `call(fetchBoard)` -> `call(fetchActions)` -> `put(errorSet)` if the POST failed -> return the payload so the caller can surface `note`. That is the existing `mutate()` order (`App.tsx:144-170`), expressed once. A component that forgets the re-read can no longer exist, because the component no longer performs writes.

*Alternative rejected: optimistic updates.* Moving a card on screen before the route confirms it would let the screen disagree with Postgres and would break the refusal/restore rules (invariants 19 and 23).

### Decision: sagas own timers and window events

The 5s live poll becomes `while (true) { delay(5000); if (visible) put(boardRequested({ silent: true })) }`, started and cancelled by `START_POLL`/`STOP_POLL`. `focus` and `visibilitychange` become an `eventChannel`. The cover letter gets `delay(3000)` with a `race` against the 3-minute deadline. `setInterval` + `Date.now()` bookkeeping disappears from the components.

`takeLatest` is used for reads and single-shot mutations so a stale in-flight request cannot overwrite a newer result. It cancels the saga task, not the underlying `fetch`; a late response is simply never `put`.

### Decision: form drafts stay local

`VacancyModal`'s `detailsDraft` is seeded once on purpose, so the 5s poll cannot overwrite typing (`VacancyModal.tsx:164-171`). Drafts and their dirty flags stay component state; only server state and in-flight flags move to the store. The same applies to the manual-vacancy form and the login fields.

### Decision: the store is a cache, not a source of truth

Nothing is persisted, no write is queued locally, and every write re-reads `/api/board`. The store answers "what did the last read say", exactly like the current `cards` array does. Rejected: a persisted store or a local mutation queue - both would give the board a second source of truth, which `apps/backoffice/AGENTS.md` forbids.

### Decision: scope stops at the three orchestrated islands

The board, the cover-letter page and the admin page have real orchestration (timers, write -> re-read, a poll with a deadline). `/analytics`, `/processes`, `/sources`, `/new-vacancy`, `/vacancy/<id>` and `/login` each own a single `fetch` or a plain form; a slice and a saga would add indirection without removing any. They keep their `useState` shape in this change.

*Alternative rejected: migrating every island for uniformity.* Uniformity is not a contract, and the extra files would be reviewed without changing behaviour.

## Risks / Trade-offs

- **Bundle size.** Four packages, but Astro code-splits per page: only the islands that import `src/state` pay for it. The unchanged pages stay as they are.
- **Indirection.** The board's logic moves from one readable component into slices, selectors and sagas. Mitigation: `src/lib/*` keeps every rule, and the sagas are tested by effect order, so the reading path is `component -> action -> saga -> api/client`.
- **A late response.** `takeLatest` prevents a stale result from being stored, but it cannot abort the network call; the request still completes in the browser.
- **Test surface.** Saga tests need a fake store and stubbed `api/client` functions. They run in the existing node-environment vitest setup, with no jsdom.
- **DevTools.** State stays plain and serializable, so Redux DevTools and JSON logging remain readable.