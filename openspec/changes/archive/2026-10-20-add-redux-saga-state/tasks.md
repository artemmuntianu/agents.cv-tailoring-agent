# Tasks

## 1. Foundation

- [x] 1.1 Add `redux@^5`, `react-redux@^9`, `redux-saga@^1.5` and `reselect@^5` to `apps/backoffice/package.json`, run `npm install`, and verify `npm ls --depth=0` resolves one version of each.
- [x] 1.2 Create `src/state/store.ts`, `rootReducer.ts`, `rootSaga.ts`, `hooks.ts`, `IslandProvider.tsx`, `api/client.ts` and `events.ts`; verify `npx tsc --noEmit` passes.
- [x] 1.3 Add `src/state/api/client.test.ts`, `src/state/state.test.ts`, `src/state/sagas.test.ts` and `src/state/IslandProvider.test.ts` covering the JSON content-type, 401/`{ ok: false }`, store isolation, board normalisation/filtering and the write/poll order; verify `npx vitest run src/state`.
- [x] 1.4 Add the `src/state/` row and the state-layer conventions (store is a cache, no module singleton, sagas own effects) to `apps/backoffice/AGENTS.md`; verify the new section names every module created in 1.2.

## 2. Board reads

- [x] 2.1 Create `src/state/board/{slice,selectors}.ts` for `cards` keyed by `jobId`, `order`, `loading`, `error`, `note` and `live`, plus selectors for visible cards, per-column counts, archived count and card by id, with focused tests in `src/state/state.test.ts`; verify `npx vitest run src/state`.
- [x] 2.2 Create `src/state/{filters,dialogs,vocabulary}/{slice,selectors}.ts` with the defaults from `lib/filters.ts` and tests in `src/state/state.test.ts` for chip toggles, active-filter count and dialog open/close; verify `npx vitest run src/state`.
- [x] 2.3 Create `src/state/board/sagas.ts` and tests in `src/state/sagas.test.ts` for `fetchBoard`, the 5s poll and the 401 redirect; verify the tests assert the read and `delay` order with `runSaga`.
- [x] 2.4 Rewire `src/components/App.tsx` to `IslandProvider`, selectors and dispatches, touching `BoardToolbar.tsx`, `FilterDialog.tsx` and `KanbanBoard.tsx` only where a prop becomes a selector; verify `npm test`, `npx tsc --noEmit` and `npm run build`.

## 3. Board writes

- [x] 3.1 Add `mutateSaga` plus `move`, `action`, `archive`, `restore` and `remove` watchers to `src/state/board/sagas.ts`, with tests in `src/state/sagas.test.ts` pinning POST -> board read -> actions read -> error, and the `note` passthrough; verify `npx vitest run src/state`.
- [x] 3.2 Add interview add/edit/remove, history edit/remove, details save and docx upload sagas; verify the client test covers the `FormData` path (no JSON content-type) and the 401 redirect.
- [x] 3.3 Remove `refresh`, `loadActions` and `mutate` from `App.tsx` and route `VacancyModal` callbacks to dispatches; verify `npm test`, `npx tsc --noEmit` and `npm run build`.

## 4. Cover letter

- [x] 4.1 Create `src/state/cover/{slice,selectors,sagas}.ts` and a test in `src/state/sagas.test.ts` for the read and the 3s poll stopping when the letter lands, reusing `lib/cover.ts`; verify `npx vitest run src/state`.
- [x] 4.2 Rewire `src/components/CoverLetterPage.tsx` to selectors and dispatches, keeping the copied-text interaction local; verify `npx tsc --noEmit` and `npm run build`.

## 5. Admin vocabulary

- [x] 5.1 Create `src/state/admin/{slice,selectors,sagas}.ts` and a test in `src/state/sagas.test.ts` for the read, add and the re-read that follows a write, reusing `lib/admin.ts`; verify `npx vitest run src/state`.
- [x] 5.2 Rewire `src/components/AdminApp.tsx` (and `ActionVocabulary.tsx` only if a prop becomes a selector); verify `npx tsc --noEmit` and `npm run build`.

## 6. Integration

- [x] 6.1 Run the full gates from `apps/backoffice`: `npm test` (42 files / 438 tests), `npx tsc --noEmit` and `npm run build`; fix every regression before ticking this task.
- [x] 6.2 Re-read `apps/backoffice/AGENTS.md` against the finished modules and refresh the Layout, Commands and Deliberately missing sections where a fact moved; verify the diff names the state layer, its rules and the no-persisted-store omission.
- [x] 6.3 Run `openspec validate add-redux-saga-state --strict`; verify it passes and that `git status --short` lists only the paths this proposal names.

## Workflow follow-up

- Archive the change with `openspec archive add-redux-saga-state` once the review is satisfied, then confirm `openspec list --specs` is unchanged because this change carries no spec delta.
- The browser checks against the port-forwards (a real move, archive/restore, the cover-letter page and `/admin`) remain operator verification: the suite is hermetic and `npm run build` only proves the bundle.