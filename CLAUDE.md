# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin to sort and permute lines, lists, and headings. Forked from Vinzent03/obsidian-sort-and-permute-lines.

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-sort-lines` row). Read it when starting work; update it when that step ships.

## Architecture

### Module Split

`src/sort.ts` holds the pure algorithms (`sortHeadings`, `sortListLines`, `collectLines`, `replaceLinksOnLine`, `getFrontStart`, `CHECKBOX_REGEX`) and their types (`Line`, `HeadingPart`, `ListPart`, `LinkRef`, `HeadingRef`) — no runtime Obsidian dependency, so tests import them directly. `main.ts` is the thin orchestrator: editor state in, sort.ts functions, editor write back.

`collectLines(text, { links, headings, start, end })` builds the `Line[]` for a range. `end` is **inclusive** (it mirrors `EditorContext.end`), and `lineNumber` stays **absolute** — `sortListLines` pads to `inputLines[0].lineNumber` against a cacheMap keyed by absolute line, so renumbering from zero would silently break list sorting.

### Recursive Structures

- **Headings** (`HeadingPart`): `sortHeadings` builds a tree from heading levels; `getSortedHeadings` recurses, collecting content lines until a same-or-higher-level heading; subheadings are sorted at each level.
- **Lists** (`ListPart`): `sortListRecursively` uses `cache.listItems` (Obsidian's `ListItemCache.parent` is the parent line number, negative for top-level). `getSortedListParts` recurses by comparing parent pointers. Blank lines inside the list abort the sort.

### Build & Release

- `build.ts` uses Bun's bundler. Entry `src/main.ts` → `./main.js` (CJS, minified in prod). Externals: `obsidian`, `electron`.
- `version-bump.ts` syncs `package.json` version → `manifest.json` + `versions.json`.
- Release: push an annotated tag (e.g., `1.0.0`) to trigger GitHub Actions. Merge PRs before tagging.

### Tests

Tests live beside source as `src/*.test.ts` and use `bun test`. They import the real symbols from `src/sort.ts` — never re-implement an algorithm in a test file; if something isn't importable, extract it into `sort.ts` first.

## Code Style

Biome is the single source of truth (2-space indent, organized imports). Run `bun run lint:fix` before committing.
