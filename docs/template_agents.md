# Project

Astro SSR (version authoritative in `package.json`, currently `^7.2.9`), TypeScript strict, npm.
**Read `CONSTITUTION.md` and the per-layer `AGENTS.md` files before changing anything** — this stops
each agent from re-discovering the design.

## Architecture map (read first)

- **`CONSTITUTION.md`** — canonical architecture, invariants, legacy/dead code, known discrepancies.
- **`src/types/AGENTS.md`** — domain types.
- **`src/lib/AGENTS.md`** — the shadow/rendering engine (lib) — shadows only.
- **`src/lib/playgroundStorage/AGENTS.md`** — persistence (Supabase metadata + FS images).
- **`src/pages/api/AGENTS.md`** — API/backend endpoints.
- **`src/components/annotation/AGENTS.md`** — annotation tooling.
- **`src/components/viewer/AGENTS.md`** — public viewer (single renderer).
- **`src/components/admin/AGENTS.md`** — admin flow.

## Commands

```sh
npm install
npm run dev              # local dev server
npm run build            # production build
npm run lint             # ESLint flat config (0 errors, tolerated warnings)
npm run lint:fix         # …or `npm run lint -- --fix`
npm run typecheck        # tsc --noEmit
npm run preview          # preview the production build (`npm start` is an alias)
```

> **`npm dev` / `npm build` / `npm lint` shorthand does not exist** — npm only special-cases
> `npm start` / `npm test`; for anything else it must be `npm run <script>` (it answers
> `Unknown command`). And `npm run lint --fix` silently **drops** the flag (npm parses it as its
> own): use `npm run lint -- --fix` or `npm run lint:fix`.

## Linting (`eslint.config.mjs`)

ESLint 10 (flat config) + `typescript-eslint` + `eslint-plugin-astro` + `eslint-plugin-react-hooks`
(the codebase already carried three `react-hooks/exhaustive-deps` disable comments before the config
existed, so this is the stack it was written against). Severity policy — keep the command useful
**and green** so it is actually run:

- **errors** — rules the code satisfies today, so a failure means a real regression;
- **warnings** — deliberate tolerances: `@typescript-eslint/no-explicit-any` (existing `any`s),
  `react-hooks/exhaustive-deps`, `@typescript-eslint/no-unused-vars`.

`eslint-plugin-react-hooks` v7 also ships the newer React-Compiler-era rules
(`set-state-in-effect`, `immutability`, `static-components`, …). They are **opt-in**: the canvas /
effect islands (`ViewerShadowCanvas`, `AnnotationCanvas`, `EquipmentMarkerCanvas`, admin pages) do
not satisfy them yet, so enabling them wholesale would bury the signal.

## Analysis tooling (`tools/analyze.mjs`)

A type-aware (ts-morph) CLI for reference / dead-code questions and mechanical moves. It is a private
sandbox: the app's `package.json` and lockfile are deliberately untouched. Install once per clone:

```sh
cmd /c "cd /d tools && npm install"
```

```sh
node tools/analyze.mjs outline <file>           # declaration map of a file (cheap way to read it)
node tools/analyze.mjs dead-exports [--all]     # what is dead vs. framework-/Astro-referenced
node tools/analyze.mjs refs <Symbol>            # real reference resolution, not grep
node tools/analyze.mjs imports <module>         # who imports it, and what they pull
node tools/analyze.mjs typecheck                # tsc diagnostics
node tools/analyze.mjs move-symbols --from a.ts --to b.ts --names f,g [--write]
```

**Use these instead of ad-hoc greps or throwaway scripts** for "who references X?", "what is dead?",
"who imports this?", and never hand-move declarations between modules — the codemod rewires the
importers too (dry run by default; then `--write`, then `typecheck`). Details in `tools/README.md`.

## Known environment traps (do NOT re-investigate)

1. **Vercel adapter + a junctioned `node_modules`.** In a git worktree whose `node_modules` is a
   junction to another drive, `astro build` compiles everything correctly and then the adapter's
   `astro:build:done` hook fails inside `@vercel/nft` with `The URL must be of scheme file`
   (`copyDependenciesToFunction` → `fileURLToPath`). That is an environment artefact, **not** a code
   error — proven by the identical build in the main clone (`E:\Playgrounds`, real `node_modules`)
   ending with `Complete!`. Fix: run the deploy build from the main clone; in a worktree just check
   that the log reaches `Completed in …` and carry on.
2. **CRLF + multi-line edits.** The repo is CRLF; a multi-line text replacement can silently miss on
   mixed line endings, and single-line inserts arrive as LF. If a replacement misses although the
   text is visibly there: normalise that file to LF, edit, normalise back to CRLF.
3. **Capturing `node` output.** Piping node output inside PowerShell 5.1 fails intermittently here;
   redirect instead: `cmd /c "cd /d <repo> && node tools\analyze.mjs X > out.txt 2>&1"`, then read
   `out.txt`.

## Shell / commands (Windows PowerShell 5.1)

The terminal is **Windows PowerShell 5.1**, not bash/cmd. The single most-common mistake is
chaining commands with `&` / `&&`. **In PowerShell 5.1 both are reserved operators and fail when
used as "run A then B"**. The ONLY correct separator is a semicolon `;`.

- **NEVER** join two commands with `&&` or with a bare `&`. Always use `;`.
  - Wrong (errors): `cmd /c "dir /b src > a.txt" & cmd /c "dir /b data > b.txt"`
  - Right: `cmd /c "dir /b src > a.txt"; cmd /c "dir /b data > b.txt"`
- Inside a `cmd /c "..."` string, `&` / `&&` are fine — that string is handed **verbatim** to
  cmd.exe. The problem is only the `&` **between** two `cmd /c "..."` invocations (PowerShell
  parses that one).
- Prefer PowerShell-native commands over cmd.exe aliases:
  - `dir` → `Get-ChildItem`; `dir /b` / `dir /s` → `Get-ChildItem -Name` / `-Recurse`. A bare `/b`
    gets parsed as a path (`D:\b`) and errors.
  - `mkdir` → `New-Item -ItemType Directory`; `rm`/`del` → `Remove-Item`; `cp` → `Copy-Item`;
    `mv` → `Move-Item`.
- `npm` / `npx` are blocked by the Execution Policy (their `.ps1` shim cannot load). Run them
  through cmd, or call the local binary directly:
  - `cmd /c "npm run <script>"`  ·  `cmd /c "node_modules\.bin\tsc.cmd --noEmit"`
- Long-running commands (build, typecheck) sometimes return no output and report `exit code 1`
  through the shell wrapper even on success. Redirect to a file and read it back:
  `cmd /c "npm run build > out.txt 2>&1"`. **Do not treat a non-zero wrapper exit as failure —
  verify the actual log/artifact instead.**
- Always quote paths (`cd "d:\Work\play-model-portal"`).

## Conventions

- **Output language**: always respond in English, even if the user writes in another language.
- Style with Tailwind utilities inline. Extract to a component when used 3+ times.
- Server-rendered by default. Mark client islands explicitly and minimally.
- No new `any` types. Existing ones are tracked in `TODO-types.md`.

## Don't

- Add a dependency without checking `package.json` for an existing equivalent.
- Write tests.

## When unsure

Ask. A 30-second clarifying question is cheaper than a 30-minute revert.
