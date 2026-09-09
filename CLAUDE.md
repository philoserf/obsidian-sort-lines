# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin to sort and permute lines, lists, and headings. Forked from Vinzent03/obsidian-sort-and-permute-lines.

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-sort-lines` row). Read it when starting work; update it when that step ships.

## Commands

Bun is the toolchain — there is no npm/node script path.

```bash
bun test                       # full suite
bun test src/sort.test.ts      # one file
bun test -t "frontmatter"      # one test (matches the describe/it name)
bun run typecheck              # tsc --noEmit
bun run lint                   # biome check .
bun run lint:fix               # biome check --write .
bun run check                  # typecheck + lint
bun run build                  # check + bundle to ./main.js
bun run dev                    # unminified sourcemapped watch build
bun run deploy                 # copy main.js + manifest.json into a vault
```

`bun run deploy` reads `OBSIDIAN_DEPLOY_DEST` from `.env.local` (gitignored) — that is the way to
exercise a change in a real vault, since nothing here mocks the Obsidian editor.

## Architecture

### Module Split

`src/sort.ts` holds the pure algorithms (`sortHeadings`, `sortListLines`, `collectLines`, `resolveSelectionRange`, `resolveListRange`, `replaceLinksOnLine`, `getFrontStart`, `CHECKBOX_REGEX`) and their types (`Line`, `HeadingPart`, `ListPart`, `LinkRef`, `HeadingRef`, `SectionRef`, `Range`) — no runtime Obsidian dependency, so tests import them directly. `main.ts` is the thin orchestrator: editor state in, sort.ts functions, editor write back.

`resolveSelectionRange` / `resolveListRange` decide *which* lines to sort; `collectLines(text, { links, headings, start, end })` then builds the `Line[]` for that range. `main.ts` reads the editor into a plain `bounds` record and calls them — the range decision itself holds no Obsidian types, so it is unit-testable. `end` is **inclusive** (it mirrors `EditorContext.end`), and `lineNumber` stays **absolute** — `sortListLines` pads to `inputLines[0].lineNumber` against a cacheMap keyed by absolute line, so renumbering from zero would silently break list sorting.

### Recursive Structures

- **Headings** (`HeadingPart`): `sortHeadings` builds a tree from heading levels; `getSortedHeadings` recurses, collecting content lines until a same-or-higher-level heading; subheadings are sorted at each level.
- **Lists** (`ListPart`): `sortListRecursively` uses `cache.listItems` (Obsidian's `ListItemCache.parent` is the parent line number, negative for top-level). `getSortedListParts` recurses by comparing parent pointers. Blank lines inside the list abort the sort.

### Strictness

`tsconfig.json` sets `noUncheckedIndexedAccess`. The `if (!current) break;` / `if (!from || !to) continue;` guards after every array index are what that setting requires — they are not dead defensive code, and removing one trades a compile error for a non-null assertion.

Tests are **excluded from `tsconfig.json`'s `include`**, so `bun run typecheck` (and therefore `check` and `build`) never type-checks `src/*.test.ts`. Type errors can and do accumulate there unnoticed; `bun test` still runs them.

### Build & Release

- `build.ts` uses Bun's bundler. Entry `src/main.ts` → `./main.js` (CJS, minified in prod). Externals: `obsidian`, `electron`.
- **`main.js` is a committed build artifact.** Obsidian ships the bundle, so CI runs `bun run build` then `git diff --exit-code main.js` — any source or dependency change that is not accompanied by a rebuilt, committed `main.js` fails the PR. Bun is deliberately unpinned in CI, so a bundler-output shift trips the same check; the fix either way is rebuild and commit.
- `version-bump.ts` syncs `package.json` version → `manifest.json` + `versions.json`.
- Releasing: use the `obsidian-gate` then `obsidian-ship` skills — do not tag by hand. `obsidian-ship` is user-invoke-only. The release workflow fires on a `MAJOR.MINOR.PATCH` tag and builds + uploads `main.js` and `manifest.json`; it does **not** run the tests, so the gate is the only thing standing between a bad commit and a release.

### Tests

Tests live beside source as `src/*.test.ts` and use `bun test`. They import the real symbols from `src/sort.ts` — never re-implement an algorithm in a test file; if something isn't importable, extract it into `sort.ts` first.

## Code Style

Biome is the single source of truth (2-space indent, organized imports). Run `bun run lint:fix` before committing. Note `biome.json` scopes `files.includes` to `src/**`, the root `*.json`, and the three root scripts — a new root `.ts` file is invisible to the linter until it is added there and to `tsconfig.json`'s `include`.

## Issues Backlog

`.issues/` holds findings written by the `code-audit`, `code-reduction`, `code-refactor`, `code-theory`, and `code-walkthrough` skills. They are recommendations, not applied changes — check for an existing file before re-reporting something, and delete the file when the finding ships.
